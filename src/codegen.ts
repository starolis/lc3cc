// Code generator for the documented teaching subset. It uses mechanical
// load-operate-store idioms for expressions and implements the complete
// stack-frame calling convention described below.
//
// SCOPE: expressions, statements, globals, capacity guards, the full calling
// convention, crt0, and capacity diagnostics for calls and address reach.
// Codegen assumes its input already passed check() with no error diagnostics;
// it does not revalidate semantics, only emits code and reports its own
// capacity diagnostics.
//
// Calling convention contract, including return-slot ownership and the
// shared function epilogue:
//
// - ONE shared epilogue per function (label `L_<func>_epilogue`, emitted
//   once, right after the body): every explicit `return` evaluates its
//   value (if any), stores it to R5+3 itself, then branches to the shared
//   tail, which only pops the frame and RETs — it never writes R5+3. The
//   implicit fall-off-the-end path reaches that same tail by falling
//   through, executing no STR at all, so a missing return's slot is
//   genuinely untouched (residue, not a zero or a stale-but-deterministic
//   value from some other statement). This preserves the teaching contract
//   that an omitted return value remains unspecified. Every return goes
//   through one shared epilogue instead of duplicating the full frame
//   teardown and RET at each return site.
// - A single-return function therefore emits one harmless extra
//   `BR L_f_epilogue` immediately followed by that same label — the same
//   non-optimizing, mechanical style used throughout this generator
//   (e.g. every if/else emits `BR L_f_done` right before `L_f_done`).
//   Nothing here peephole-optimizes that away; optimization is explicitly
//   out of scope.
// - crt0 (R4/R6 init, call main, HALT, wrapped in its own .ORIG/.END) is
//   emitted only when the program defines `main` with a body. Fragment
//   compilation intentionally permits synthetic functions without `main`;
//   gating crt0 on `main` keeps those fragments free of .ORIG/.END while
//   still producing a real, runnable image
//   whenever a full C program (which always has main) is compiled.
//
// Register discipline throughout: R0-R3 are scratch and dead
// across statements — no register allocation. Every expression evaluates
// left-to-right into R0 by convention; a binary operator's general shape is
// "evaluate left into R0, spill R0 to a temp, evaluate right into R0, reload
// left into R1, combine R1-op-R0 into R0" — this is the load-operate-store
// idiom applied uniformly, and it is why temporary slots belong to codegen:
// every nested subexpression may need a fresh spill slot, but only the
// high-water mark of SIMULTANEOUSLY open slots needs a physical frame slot
// (push/pop is stack-disciplined, matching expression nesting depth).
// Checking owns names, types, storage classes, and constant-expression facts.
// Codegen consumes those resolved facts without performing a second semantic pass.
// Generated assembly remains deliberately mechanical so source constructs stay visible.
// Capacity guards report when an otherwise valid program exceeds an encoding boundary.
// Line maps distinguish source work, call bookkeeping, runtime code, and literal data.

import type {
  Assign,
  AssignOp,
  Binary,
  BinaryOp,
  Block,
  Break,
  Call,
  Continue,
  CType,
  DoWhile,
  Expr,
  For,
  FuncDecl,
  Ident,
  If,
  Member,
  Program,
  Return,
  Stmt,
  Subscript,
  Switch,
  TypeSpec,
  Unary,
  VarDecl,
  While,
} from './ast.js';
import { isArray, isPointer, isStruct, sizeInWords } from './ast.js';
import { constFoldProbe, foldConstExpr } from './check.js';
import type { CcDiagnostic } from './diagnostics.js';
import { wrapTo16Signed } from './int16.js';
import { RTHP_BASE, RTHP_CEIL, RUNTIME_ORDER, RUNTIME_SECTIONS } from './runtime.js';
import { localWordCount } from './symbols.js';
import type { FuncFrame, SymbolTables, VarSymbol } from './symbols.js';

export interface CLineMapEntry {
  cLine: number | null;
  asmStart: number;
  asmEnd: number;
  // 'startup' is crt0's own generated bootstrap block (R4/R6 init, the call
  // into main, HALT) and 'runtime' is spliced runtime code (the standard
  // library, malloc/free, and operator helpers) — both real, executing
  // instructions, distinct from 'data' (true literal words:
  // .FILL/.STRINGZ/pools/globals). Executing instructions retain an executing
  // map kind so stepping and visualization reflect real behavior. Conversely,
  // literal words trailing those blocks always map as data: this includes
  // CRT0_GLOBAL/CRT0_STACK .FILL and each runtime section's literal tail.
  // Those words never inherit the enclosing block's 'startup' or 'runtime'
  // kind.
  // 'startup' covers only the generated entry sequence that executes before main.
  // 'runtime' covers executing helper instructions spliced after user functions.
  // 'data' covers assembled words that are inspected but never executed as code.
  // Statement, call, prologue, and epilogue kinds retain their source-step roles.
  kind: 'stmt' | 'prologue' | 'epilogue' | 'call' | 'data' | 'startup' | 'runtime';
}

export interface CodegenResult {
  asm: string;
  lineMap: CLineMapEntry[];
  diagnostics: CcDiagnostic[];
}

function err(node: { line: number; col: number }, message: string): CcDiagnostic {
  return { line: node.line, col: node.col, message, severity: 'error' };
}

// ---- output buffer: lines + the lineMap entries carved out of them ----

// A defense-in-depth backstop limits emitted assembly size. The
// macro-expansion budget (lexer) and the expression-depth
// guard (parser) fire first on the known pathologies, so in practice codegen
// never reaches this — but any FUTURE path that emits without bound stops here
// before the buffer can exhaust memory. codegen() catches this and turns it
// into a named capacity diagnostic. 262144 = 2^18. Exported for a direct unit
// test (reaching it through compileC is infeasible in a fast test).
export const MAX_EMITTED_LINES = 262144;

export class EmittedLinesExceededError extends Error {}

export class LineBuffer {
  lines: string[] = [];
  entries: CLineMapEntry[] = [];

  add(text: string): void {
    if (this.lines.length >= MAX_EMITTED_LINES) {
      throw new EmittedLinesExceededError();
    }
    this.lines.push(text);
  }

  get nextLineNo(): number {
    return this.lines.length + 1;
  }

  get lastLineNo(): number {
    return this.lines.length;
  }

  entry(cLine: number | null, kind: CLineMapEntry['kind'], start: number, end: number): void {
    this.entries.push({ cLine, asmStart: start, asmEnd: end, kind });
  }
}

// Wraps [start, end] in one or more entries of `kind`, skipping any
// sub-ranges already claimed by entries added since `entriesBefore` — the
// calling convention's lineMap contract carves a call's cleanup out as its
// own 'call'-kind entry (see emitCall), even when the call is nested inside
// a larger expression (`x = f(1) + g(2);`), so the enclosing statement's
// own entry must not overlap it. When nothing was added in between (the
// overwhelming common case: no calls in this expression), this reduces to
// exactly one entry spanning [start, end] — identical to a plain
// buf.entry() call, so expressions without nested calls retain the same
// single-entry map shape.
function wrapEntry(
  buf: LineBuffer,
  cLine: number | null,
  kind: CLineMapEntry['kind'],
  start: number,
  end: number,
  entriesBefore: number,
): void {
  const subRanges = buf.entries
    .slice(entriesBefore)
    .map((en) => [en.asmStart, en.asmEnd] as const)
    .sort((a, b) => a[0] - b[0]);
  let cursor = start;
  for (const [subStart, subEnd] of subRanges) {
    if (subStart > cursor) buf.entry(cLine, kind, cursor, subStart - 1);
    cursor = subEnd + 1;
  }
  if (cursor <= end) buf.entry(cLine, kind, cursor, end);
}

// A `LABEL .FILL/.STRINGZ/.BLKW ...` line — an assembled literal word, as
// opposed to an executing instruction. Same shape family lineLabel matches
// (a label PREFIXED on a data directive). Literal words
// always map as 'data', never lumped into an executing 'startup'/'runtime'
// span. The regex requires a leading label token, so a bare `.FILL #0`
// (which starts with `.`) is not matched here — those bare-directive globals
// are already emitted as their own 'data' entries in emitGlobalsSection.
const DATA_DIRECTIVE_RE = /^(\S+)\s+\.(?:FILL|STRINGZ|BLKW)\b/i;

function isDataDirectiveLine(text: string): boolean {
  return DATA_DIRECTIVE_RE.test(text.trim());
}

// Split a just-emitted block [start..end] into contiguous runs, mapping each
// literal-word line (isDataDirectiveLine) as 'data' and every other line as
// codeKind, so a trailing literal tail never inherits the executing block's
// 'startup'/'runtime' kind. This scans generally rather than
// assuming the data words sit in one contiguous tail, so future block edits
// can't silently regress the classification.
function entrySplittingData(
  buf: LineBuffer,
  codeKind: CLineMapEntry['kind'],
  start: number,
  end: number,
): void {
  let runStart = start;
  let runIsData = isDataDirectiveLine(buf.lines[start - 1]);
  for (let ln = start + 1; ln <= end; ln++) {
    const isData = isDataDirectiveLine(buf.lines[ln - 1]);
    if (isData !== runIsData) {
      buf.entry(null, runIsData ? 'data' : codeKind, runStart, ln - 1);
      runStart = ln;
      runIsData = isData;
    }
  }
  buf.entry(null, runIsData ? 'data' : codeKind, runStart, end);
}

// Chained ADDs past imm5 range (-16..15) are deterministic and shared by
// frame-reservation placeholders and real function prologues/epilogues.
// A zero delta produces no instructions.
function chainedAdd(reg: string, delta: number): string[] {
  const out: string[] = [];
  let remaining = delta;
  while (remaining !== 0) {
    const chunk = remaining > 0 ? Math.min(remaining, 15) : Math.max(remaining, -16);
    out.push(`ADD ${reg},${reg},#${chunk}`);
    remaining -= chunk;
  }
  return out;
}

// Same imm5 chunking as chainedAdd, but `dest` doesn't already hold the base
// value: the FIRST add reads it from `src` (`dest = src + chunk`), every
// later chunk accumulates into `dest` itself. For |delta| <= 15 this is a
// single `ADD dest,src,#delta`, matching the cross-register add used by
// emitIncDecSymbol's postfix branch. Chunking ensures a delta wider than
// imm5 (such as a pointer's postfix increment) still assembles
// instead of truncating.
function chainedAddFrom(dest: string, src: string, delta: number): string[] {
  const out: string[] = [];
  let remaining = delta;
  let from = src;
  while (remaining !== 0) {
    const chunk = remaining > 0 ? Math.min(remaining, 15) : Math.max(remaining, -16);
    out.push(`ADD ${dest},${from},#${chunk}`);
    from = dest;
    remaining -= chunk;
  }
  return out;
}

// Re-escapes a resolved string for a .STRINGZ operand. The assembler's
// .STRINGZ understands \n \t \r \0 \\ \" and takes any other character
// literally — so LF/CR (which would break its line/operand parse) MUST be
// emitted as escapes, while the remaining Table D.1 control characters
// (\v \b \f \a) round-trip correctly as raw literal bytes.
function escapeForStringz(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\0') out += '\\0';
    else out += ch;
  }
  return out;
}

function trimSourceLine(sourceLines: readonly string[], line: number): string {
  return (sourceLines[line - 1] ?? '').trim();
}

// ---- variable resolution: codegen reads the symbol check.ts's resolver
// (scopes.ts) already stamped onto each Ident/VarDecl during checking, so both
// passes bind every occurrence to the exact same slot with no second lookup
// pass. A missing stamp means check() would have rejected the
// program (an undeclared/shadowed name), so codegen never runs on it — the
// guards below turn that impossible case into a clear internal error. ----

function resolvedOf(ident: Ident): VarSymbol {
  if (!ident.resolved) {
    throw new Error(`codegen: identifier '${ident.name}' was not resolved by check()`);
  }
  return ident.resolved;
}

function resolvedDeclOf(decl: VarDecl): VarSymbol {
  if (!decl.resolved) {
    throw new Error(`codegen: declaration '${decl.name}' was not resolved by check()`);
  }
  return decl.resolved;
}

// Stack-disciplined spill-slot counter: push() opens a temp (returns its
// index), pop() closes the most recently opened one. highWater is the
// number of physical frame slots pass 2 must reserve below the locals.
class TempAllocator {
  private depth = 0;
  highWater = 0;

  push(): number {
    const idx = this.depth++;
    if (this.depth > this.highWater) this.highWater = this.depth;
    return idx;
  }

  pop(): void {
    this.depth--;
  }
}

interface PoolEntry {
  label: string;
  value: string; // already-formatted .FILL operand: "#123" or a label name
}

// Maximum emitted-line distance between literal-pool islands. An LD's
// PCoffset9 reaches 255 words forward. The interval of 120 leaves room for the
// statement that crosses the threshold to finish before its island lands.
// The largest measured nested-loop span is 205 words, leaving 50 words of
// hardware reach. Islands land only between top-level statements so control
// flow never branches over data in the middle of a statement emitter.
// A single statement can still exceed the available reach by itself; the
// final address pass reports that capacity error from the actual layout.
// This interval is therefore an early placement policy, not a substitute for
// relocation validation. Any adjustment must keep the completed span within
// the signed PCoffset9 range.
const POOL_ISLAND_INTERVAL = 120;

interface StringEntry {
  label: string;
  text: string;
}

// Per-function codegen state: label/pool counters, the temp allocator, and
// the accumulated per-function literal pool (placed immediately after the
// function's emitted body — see emitFunction). Variable resolution is not a
// codegen concern: check.ts stamps every occurrence with its resolved symbol,
// which this pass reads via resolvedOf/resolvedDeclOf.
class FnCtx {
  labelCounter = 0;
  poolCounter = 0;
  poolIslandCounter = 0;
  pool: PoolEntry[] = [];
  // Line number of the body buffer at the last island flush — the distance
  // every pending pool LD still has to reach. See flushPoolIsland.
  poolAnchor = 0;
  temps = new TempAllocator();
  breakLabels: string[] = [];
  continueLabels: string[] = [];
  // Every explicit `return` branches here instead of duplicating the pop
  // frame/RET sequence (see the module header's calling-convention notes
  // and emitFunction/emitReturn).
  readonly epilogueLabel: string;
  // The C line of whichever statement is currently being emitted — set by
  // every statement-level emitter right before it descends into expression
  // codegen, read by emitCall to tag its cleanup entry with the call's
  // statement line (the lineMap contract: cleanup is a 'call'-kind entry on
  // the *call's* line, not some other bookkeeping line).
  currentCLine: number | null = null;
  // A local char array's string-literal initializer needs
  // its own, UNSHARED, padded copy of the text somewhere in the data
  // section — the exact opposite of poolString's sharing, since a write
  // through the array must never be able to corrupt an identical literal
  // read elsewhere in the program. Never deduped against another entry
  // here, even an identical one: two `char buf[4] = "hi";` locals need two
  // independently writable copies. Emitted after this function's own
  // literal pool (see emitFunction).
  localStringCounter = 0;
  localStrings: { label: string; text: string; words: number; name: string }[] = [];

  constructor(
    readonly funcName: string,
    private readonly prog: ProgCtx,
  ) {
    this.epilogueLabel = `L_${funcName}_epilogue`;
  }

  nextLabel(): string {
    return `L_${this.funcName}_${this.labelCounter++}`;
  }

  // Operator lowering emits `JSR RTMUL`-shaped lines that the splice
  // gate's `JSR F_<name>` scan can never match, so emitOpCall records the
  // section key here, at the moment the JSR is emitted.
  registerOpSection(key: string): void {
    this.prog.usedOpSections.add(key);
  }

  // The declared type of the callee's `index`-th parameter, or undefined when
  // the callee has no user frame (a builtin) or takes fewer parameters. Lets
  // emitCall canonicalize a value passed to a bool parameter.
  calleeParamType(callee: string, index: number): CType | undefined {
    return this.prog.funcFrames.get(callee)?.params[index]?.type;
  }

  // The JSR target label for a call. A user function uses its mangled base
  // from funcLabels; a builtin keeps its fixed runtime label.
  calleeLabel(callee: string): string {
    return `F_${this.prog.funcLabels.get(callee) ?? callee}`;
  }

  tempOffset(frame: FuncFrame, idx: number): number {
    return -(localWordCount(frame) + idx);
  }

  // Two identical operands share one pool word. This is bookkeeping,
  // not optimization: the emitted instruction sequence is unchanged — the same
  // LD runs, it just names a word an earlier LD already needed. What it buys is
  // reach. Each pool LD uses a forward PCoffset9 with at most 255 words of
  // range into the body, so each duplicate pushes the pool farther away
  // from the LDs above it.
  private pooledLabelFor(value: string): string | null {
    const hit = this.pool.find((p) => p.value === value);
    return hit ? hit.label : null;
  }

  poolConstant(value: number): string {
    const encoded = `#${wrapTo16Signed(value)}`;
    const existing = this.pooledLabelFor(encoded);
    if (existing) return existing;
    const label = `C_${this.funcName}_${this.poolCounter++}`;
    this.pool.push({ label, value: encoded });
    return label;
  }

  poolString(text: string): string {
    // Identical literals share one .STRINGZ program-wide, and one pool word per
    // function that names it. Both are safe: the subset has no way to mutate a
    // string literal, so two literals with the same text are indistinguishable.
    const known = this.prog.strings.find((s) => s.text === text);
    const strLabel = known ? known.label : `S_${this.prog.stringCounter++}`;
    if (!known) this.prog.strings.push({ label: strLabel, text });
    return this.poolLabelAddress(strLabel);
  }

  // The ADDRESS of an already-emitted label, pooled the same way poolString's
  // own second-level indirection uses (a `.FILL LABEL` word resolves to the
  // label's address). A local string-initializer blob's
  // label (addLocalStringInit) can reuse the exact same indirection.
  poolLabelAddress(label: string): string {
    const existing = this.pooledLabelFor(label);
    if (existing) return existing;
    const ptrLabel = `C_${this.funcName}_${this.poolCounter++}`;
    this.pool.push({ label: ptrLabel, value: label });
    return ptrLabel;
  }

  // A fresh, unshared data blob for a local char array's string-literal
  // initializer. `words` already includes the terminator and any padding;
  // checkStringArrayInit determines that size and records it in the symbol's
  // initWords array. This pass consumes that resolved length rather than
  // deriving it again. The generated label owns
  // that many words once emitFunction emits it. `name` is the local
  // variable's own name, carried through only so the emitted padding words
  // can carry the same `; <name>` comment a global's own padding words do.
  addLocalStringInit(text: string, words: number, name: string): string {
    const label = `SI_${this.funcName}_${this.localStringCounter++}`;
    this.localStrings.push({ label, text, words, name });
    return label;
  }

  // Drop the pending pool into the body as an island and branch over it.
  // Every pooled operand is an LD whose PCoffset9 reaches 255 words forward.
  // A single pool after the whole body can place an early load beyond
  // that range as later statements accumulate. Emitting the pool near its
  // users keeps each span short at the cost of one BR per island. Branching
  // over embedded data is the documented assembly idiom, and the pool remains
  // outside the executed instruction path. The final reach pass validates
  // every generated load against its actual laid-out target distance.
  // Each island is therefore both locally readable and hardware-reachable.
  flushPoolIsland(buf: LineBuffer): void {
    if (this.pool.length === 0) {
      this.poolAnchor = buf.lastLineNo;
      return;
    }
    const skip = `L_${this.funcName}_POOL_${this.poolIslandCounter++}`;
    const start = buf.nextLineNo;
    buf.add(`BR ${skip}`);
    for (const p of this.pool) buf.add(`${p.label} .FILL ${p.value}`);
    buf.add(`${skip}`);
    // The BR executes; the .FILLs are data. entrySplittingData draws that line
    // so no student ever sees a literal word labelled as an instruction, or the
    // reverse. cLine is null because no C statement requested this data.
    entrySplittingData(buf, 'stmt', start, buf.lastLineNo);
    // A word already flushed may sit out of reach of a later LD, so dedup only
    // ever looks within the island being built.
    this.pool = [];
    this.poolAnchor = buf.lastLineNo;
  }
}

interface ProgCtx {
  buf: LineBuffer;
  diagnostics: CcDiagnostic[];
  // Every user function's frame, keyed by name — read by emitCall to learn a
  // callee's parameter types so a value passed to a bool parameter can be
  // canonicalized to 0/1. Builtins (putchar/getchar/printf/scanf/
  // strcmp/strcpy) are absent here and take no bool parameters, so their
  // args are never converted.
  funcFrames: Map<string, FuncFrame>;
  // Each user function's exact C name maps to a case-safe assembler-label
  // base. Callers prepend `F_` for the call label and use the base as the
  // internal-label stem. Absent for builtins, whose runtime labels are fixed.
  funcLabels: Map<string, string>;
  // Label bases whose actual `F_<base>` definition was emitted. The
  // malloc/free scan filter must use this exact set rather than all function
  // symbols: builtins have signatures but intentionally no emitted body, and
  // a capacity-rejected user function can return before its label is written.
  emittedUserLabelBases: Set<string>;
  // Operator runtime sections registered explicitly: RUNTIME_SECTIONS
  // keys ('op-mul'/'op-divmod'), recorded here because operator lowering
  // emits JSR RTMUL/RTDIV/RTMOD — no `JSR F_<name>` line for the splice
  // gate's scan to find. Written by emitOpCall ('op-mul' for `*`,
  // 'op-divmod' for `/` and `%`); collectRuntimeNames unions it with the
  // scan.
  usedOpSections: Set<string>;
  stringCounter: number;
  strings: StringEntry[];
  // Split once per compilation (not per statement — a per-statement split
  // made commentHeader's source-comment annotation O(statements x
  // sourceLength)) and reused by every commentHeader() call.
  sourceLines: readonly string[];
}

// =========================================================================
// Expression codegen — every expression leaves its value in R0.
// =========================================================================

function reg(n: number): string {
  return `R${n}`;
}

function baseReg(sym: VarSymbol): string {
  return sym.storage === 'global' ? 'R4' : 'R5';
}

// LDR/STR's offset6 field is a 6-bit signed immediate (Appendix A).
export function offsetFitsLdr(offset: number): boolean {
  return offset >= -32 && offset <= 31;
}

// ADD's imm5 field is a 5-bit signed immediate. `emitConstant` and
// `emitAddressOfSymbol` below are its two callers, the latter computing a
// variable's ADDRESS via `ADD Rd,Rbase,#offset` when the offset fits.
// Exported so tests and other emitters can use the same immediate-range
// predicate as `emitAddress`; current production calls remain in this file.
export function offsetFitsImm5(offset: number): boolean {
  return offset >= -16 && offset <= 15;
}

// Far accessors materialize an address when offset6 cannot reach it.
// An array pushes later locals and temporaries past offset6, so the direct
// form stops reaching. Both fallbacks below are three instructions and apply
// only outside -32..31, so near offsets keep the direct one-instruction
// sequence.
//
// THE LOAD needs no scratch: it computes the address into the destination
// register, which it is about to overwrite anyway. This holds even where a
// live value sits in another register — emitLoadTemp(1, ...) with R0 holding
// a live right operand.
//
// THE STORE needs an address register distinct from the value, and uses R3.
// INVARIANT: R3 IS NEVER LIVE ACROSS A STORE. The far-store path therefore
// uses R3 as its address register without spilling another value. Division
// keeps its sign flags in the runtime section's own nearby frame slots, so
// it does not reserve R3 across a generated store. Every store emitter in
// this file preserves the invariant, and new store sites must do the same.
// This keeps the near and far paths semantically interchangeable.
// Direct STR leaves condition codes unchanged, while the far LD/ADD path sets them.
// Every branch consumer therefore establishes its own condition codes after a store.
// No expression result remains live in R3 when emitStoreOffset is entered.
// These rules make address materialization invisible to surrounding expression code.
//
// SECOND INVARIANT, also load-bearing and stated nowhere else: the far
// store's LD/ADD both set condition codes (N/Z/P), where the direct STR sets
// none — so "no CC dependency crosses a store" is required for the far
// fallback to be safe, not just convenient. Checked against every CC
// consumer in this file: each one re-tests explicitly (an `ADD Rn,Rn,#0`)
// before branching on it, so nothing here relies on CC surviving across a
// store. Any new branch-on-inherited-CC-across-a-store would break under the
// far case even though the near case (a plain STR) would hide it.
const STORE_ADDR_REG = 3;

function emitLoadOffset(
  dest: number,
  base: string,
  offset: number,
  buf: LineBuffer,
  fn: FnCtx,
): void {
  if (offsetFitsLdr(offset)) {
    buf.add(`LDR ${reg(dest)},${base},#${offset}`);
    return;
  }
  buf.add(`LD ${reg(dest)},${fn.poolConstant(offset)}`);
  buf.add(`ADD ${reg(dest)},${base},${reg(dest)}`);
  buf.add(`LDR ${reg(dest)},${reg(dest)},#0`);
}

function emitStoreOffset(
  src: number,
  base: string,
  offset: number,
  buf: LineBuffer,
  fn: FnCtx,
): void {
  if (src === STORE_ADDR_REG) {
    // The invariant above exists precisely to keep this from happening: a
    // far store would otherwise emit `LD R3,C / ADD R3,base,R3 / STR
    // R3,R3,#0`, overwriting the address with the (stale) value before the
    // STR reads it — a silent miscompile that only surfaces on frames large
    // enough to take the far branch, so it would sail through every
    // direct-path register contract. Fail loudly instead.
    throw new Error(
      `codegen: emitStoreOffset called with src === R${STORE_ADDR_REG} (the far-store address register) — would clobber the address before the store`,
    );
  }
  if (offsetFitsLdr(offset)) {
    buf.add(`STR ${reg(src)},${base},#${offset}`);
    return;
  }
  const a = reg(STORE_ADDR_REG);
  buf.add(`LD ${a},${fn.poolConstant(offset)}`);
  buf.add(`ADD ${a},${base},${a}`);
  buf.add(`STR ${reg(src)},${a},#0`);
}

function emitLoad(dest: number, sym: VarSymbol, buf: LineBuffer, fn: FnCtx): void {
  emitLoadOffset(dest, baseReg(sym), sym.offset, buf, fn);
}

function emitStore(src: number, sym: VarSymbol, buf: LineBuffer, fn: FnCtx): void {
  emitStoreOffset(src, baseReg(sym), sym.offset, buf, fn);
}

function emitLoadTemp(
  dest: number,
  idx: number,
  frame: FuncFrame,
  fn: FnCtx,
  buf: LineBuffer,
): void {
  emitLoadOffset(dest, 'R5', fn.tempOffset(frame, idx), buf, fn);
}

function emitStoreTemp(
  src: number,
  idx: number,
  frame: FuncFrame,
  fn: FnCtx,
  buf: LineBuffer,
): void {
  emitStoreOffset(src, 'R5', fn.tempOffset(frame, idx), buf, fn);
}

// AND Rd,Rd,#0 / ADD Rd,Rd,#imm when the constant fits imm5 (-16..15);
// otherwise a per-function literal-pool LD.
function emitConstant(dest: number, value: number, buf: LineBuffer, fn: FnCtx): void {
  const v = wrapTo16Signed(value);
  if (offsetFitsImm5(v)) {
    buf.add(`AND ${reg(dest)},${reg(dest)},#0`);
    if (v !== 0) buf.add(`ADD ${reg(dest)},${reg(dest)},#${v}`);
  } else {
    const label = fn.poolConstant(v);
    buf.add(`LD ${reg(dest)},${label}`);
  }
}

interface FrameEmit {
  frame: FuncFrame;
  buf: LineBuffer;
  fn: FnCtx;
}

// The address of a variable, into `dest`. `ADD Rd,Rbase,#offset` when the
// offset fits imm5 (-16..15), otherwise a pooled constant and a register
// ADD. This is the shape the book prints both for taking an address off the
// frame pointer (16.2.2.1) and for computing an array base (16.3.1).
function emitAddressOfSymbol(dest: number, sym: VarSymbol, e: FrameEmit): void {
  const base = baseReg(sym);
  if (offsetFitsImm5(sym.offset)) {
    e.buf.add(`ADD ${reg(dest)},${base},#${sym.offset}`);
    return;
  }
  e.buf.add(`LD ${reg(dest)},${e.fn.poolConstant(sym.offset)}`);
  e.buf.add(`ADD ${reg(dest)},${base},${reg(dest)}`);
}

// Scale an index (or an integer pointer-arithmetic operand) in R0 by
// `words`. A scale of 1 emits NOTHING. A larger factor arises for the internal
// pointer-to-array type a 2D array parameter (or `&row[i]`) decays to, where
// it is the row length, and for a pointer to a multiword complete struct.
//
// Scaling lowers through the same RTMUL call used for the `x * y` operator.
// That is deliberate: one multiply story
// everywhere, no second sequence to explain, and consistent with the
// standing rule against optimization — the algorithm lives in
// runtime.ts's op-mul section, behind the same call shape as every other
// multiply site.
function emitScaleBy(words: number, e: FrameEmit): void {
  if (words === 1) return;
  e.buf.add('ADD R1,R0,#0');
  emitConstant(0, words, e.buf, e.fn);
  emitOpCall('RTMUL', 'op-mul', e);
}

// a[i] is *(a + i). The base is an ADDRESS when `a` is an array lvalue and a
// VALUE when it is any pointer-valued expression — this branch is this
// codegen's entire handling of the array/pointer duality (16.3.5). A
// checker-stamped struct element with a constant index materializes the scaled
// constant into the exact element address, so a following Member can retain
// its own offset in LDR/STR. Every variable index and every non-struct element
// keeps the existing general RTMUL path byte-for-byte.
function emitSubscriptBase(base: Expr, e: FrameEmit): void {
  // Only an lvalue-shaped node can carry an un-decayed array type. Every
  // other checker-approved base is already a pointer value; asking the
  // deliberately lvalue-only helper for its type would reject legal shapes
  // such as (p + 1)[0], choose(p)[0], and (cond ? p : q)[0].
  switch (base.kind) {
    case 'Ident':
    case 'Deref':
    case 'Subscript':
    case 'Member':
      if (isArray(lvalueTypeOf(base))) {
        emitAddress(base, e);
        return;
      }
      break;
    default:
      break;
  }

  emitExpr(base, e);
}

function emitSubscriptAddress(expr: Subscript, e: FrameEmit): void {
  const elementWords = sizeInWords(lvalueTypeOf(expr));

  const elementType = lvalueTypeOf(expr);
  if (isStruct(elementType)) {
    const folded = constFoldIndex(expr.index);
    if (folded !== null) {
      emitSubscriptBase(expr.array, e);
      materializeAddressOffset(folded * elementWords, e);
      return;
    }
  }

  emitSubscriptBase(expr.array, e);
  const baseT = e.fn.temps.push();
  emitStoreTemp(0, baseT, e.frame, e.fn, e.buf);
  emitExpr(expr.index, e);
  emitScaleBy(elementWords, e);
  emitLoadTemp(1, baseT, e.frame, e.fn, e.buf);
  e.fn.temps.pop();
  e.buf.add('ADD R0,R0,R1');
}

// A subscript index that is a compile-time constant, or null. Reuses the
// checker's own probe (throwaway diagnostics sink, value errors suppressed)
// so a folded index can never disagree between the two passes.
function constFoldIndex(expr: Expr): number | null {
  return constFoldProbe(expr);
}

// The book's constant-subscript shape (16.3.1): compute the base, then let
// the LDR carry the index in its offset6 field. Falls back to the general
// address-then-load-at-zero form for a computed or far index.
function emitSubscriptLoad(expr: Subscript, e: FrameEmit): void {
  const elementWords = sizeInWords(lvalueTypeOf(expr));
  const folded = constFoldIndex(expr.index);
  if (folded !== null && offsetFitsLdr(folded * elementWords)) {
    emitSubscriptBase(expr.array, e);
    e.buf.add(`LDR R0,R0,#${folded * elementWords}`);
    return;
  }
  emitAddress(expr, e);
  e.buf.add('LDR R0,R0,#0');
}

function checkedMemberOffset(expr: Member): number {
  if (expr.memberOffset === undefined) {
    throw new Error(`codegen: member '${expr.member}' was not resolved by check()`);
  }
  return expr.memberOffset;
}

// Add a compile-time offset to the address in R0. Exact-address consumers need
// this even when an ordinary LDR/STR could carry a residual member offset in
// offset6. R3 is free at every expression boundary and is the standing far-
// address scratch register; no value or condition-code dependency crosses it.
function materializeAddressOffset(offset: number, e: FrameEmit): void {
  if (offset === 0) return;
  if (offsetFitsImm5(offset)) {
    e.buf.add(`ADD R0,R0,#${offset}`);
    return;
  }
  e.buf.add(`LD R3,${e.fn.poolConstant(offset)}`);
  e.buf.add('ADD R0,R0,R3');
}

// One source of truth for the member container base and its residual access
// offset. Ordinary near member reads/writes keep the offset in LDR/STR; a far
// offset is materialized once and returns residual zero. Non-member lvalues
// preserve their existing exact-address path byte for byte.
function emitLvalueBaseAndOffset(expr: Expr, e: FrameEmit): number {
  if (expr.kind !== 'Member') {
    emitAddress(expr, e);
    return 0;
  }

  if (expr.arrow) emitExpr(expr.object, e);
  else emitAddress(expr.object, e);

  const offset = checkedMemberOffset(expr);
  if (offsetFitsLdr(offset)) return offset;
  materializeAddressOffset(offset, e);
  return 0;
}

// Lvalues use a second emission protocol alongside emitExpr. emitExpr leaves
// a VALUE in R0, while emitAddress leaves an ADDRESS in R0. emitAddress is
// defined exactly on the supported lvalue forms. Any other node reaching it
// violates the checker's resolved-lvalue contract and produces an internal
// error, matching resolvedOf's discipline.
function emitAddress(expr: Expr, e: FrameEmit): void {
  switch (expr.kind) {
    case 'Ident':
      emitAddressOfSymbol(0, resolvedOf(expr), e);
      return;
    case 'Deref':
      // A pointer's VALUE is the address. Nothing to compute.
      emitExpr(expr.expr, e);
      return;
    case 'Subscript':
      emitSubscriptAddress(expr, e);
      return;
    case 'Member': {
      const residual = emitLvalueBaseAndOffset(expr, e);
      materializeAddressOffset(residual, e);
      return;
    }
    default:
      throw new Error(`codegen: '${expr.kind}' is not an lvalue (checker-enforced)`);
  }
}

// The type of an lvalue comes from the stamp check.ts records on it. Codegen
// never derives the type again, so checking and emission consume the same
// resolved result.
function lvalueTypeOf(expr: Expr): CType {
  if (expr.kind === 'Ident') return resolvedOf(expr).type;
  if (expr.kind === 'Deref' || expr.kind === 'Subscript' || expr.kind === 'Member') {
    if (!expr.resolvedType) {
      throw new Error(`codegen: '${expr.kind}' was not typed by check()`);
    }
    return expr.resolvedType;
  }
  throw new Error(`codegen: '${expr.kind}' is not an lvalue (checker-enforced)`);
}

function emitExpr(expr: Expr, e: FrameEmit): void {
  switch (expr.kind) {
    case 'IntLit':
      emitConstant(0, expr.value, e.buf, e.fn);
      return;
    case 'SizeofType':
      if (typeof expr.resolvedValue !== 'number') {
        throw new Error('codegen: sizeof type was not resolved by check()');
      }
      emitConstant(0, expr.resolvedValue, e.buf, e.fn);
      return;
    case 'Cast':
      // A legal cast only names the non-void pointer type of a void *
      // result. LC-3 pointer values already have the same one-word shape.
      emitExpr(expr.expr, e);
      return;
    case 'StrLit':
      // Legal only as printf's/scanf's format argument, or a char array's
      // initializer (checker-enforced) — the format argument is handled
      // directly by emitCall, and the initializer by
      // emitStringArrayLocalInit/emitStringArrayGlobal, so neither ever
      // reaches here as a free-standing expression.
      throw new Error('codegen: a bare string literal reached emitExpr');
    case 'Ident':
    case 'Subscript':
    case 'Member':
    case 'Deref': {
      // An array's VALUE is its base address (16.3.5), not the contents of
      // its first word — the array/pointer duality applied uniformly to
      // every lvalue-shaped node, not special-cased per kind. This is what
      // makes `Sum(a)`, `p = g[1];` (a Subscript whose own resolved type is
      // itself an array — a row of a 2D array), and `p = *(g + 1);` (a
      // Deref reached the same way, when the subset can spell one) all pass
      // a reference instead of loading through it. One type-directed rule
      // rather than a second special case beside the first, so a future
      // lvalue kind can't quietly slip past it unnoticed.
      if (isArray(lvalueTypeOf(expr))) {
        emitAddress(expr, e);
        return;
      }
      if (expr.kind === 'Ident') {
        emitLoad(0, resolvedOf(expr), e.buf, e.fn);
        return;
      }
      if (expr.kind === 'Subscript') {
        emitSubscriptLoad(expr, e);
        return;
      }
      if (expr.kind === 'Member') {
        const offset = emitLvalueBaseAndOffset(expr, e);
        e.buf.add(`LDR R0,R0,#${offset}`);
        return;
      }
      // expr.kind === 'Deref' is the only kind left in this group. Checked
      // explicitly (not a bare fallthrough) so a future kind added to this
      // case group cannot silently inherit Deref's own load shape.
      if (expr.kind === 'Deref') {
        emitAddress(expr, e);
        e.buf.add('LDR R0,R0,#0');
        return;
      }
      throw new Error("codegen: unexpected lvalue kind reached emitExpr's array-decay group");
    }
    case 'Unary':
      emitUnary(expr, e);
      return;
    case 'Binary':
      emitBinary(expr, e);
      return;
    case 'Assign':
      emitAssign(expr, e);
      return;
    case 'Call':
      emitCall(expr, e, true);
      return;
    case 'Cond':
      emitTernary(expr, e);
      return;
    case 'AddrOf':
      emitAddress(expr.expr, e);
      return;
  }
}

function emitUnary(expr: Unary, e: FrameEmit): void {
  if (expr.op === '++' || expr.op === '--') {
    emitIncDec(expr, e);
    return;
  }
  if (expr.op === '-') {
    emitExpr(expr.expr, e);
    e.buf.add('NOT R0,R0');
    e.buf.add('ADD R0,R0,#1');
    return;
  }
  if (expr.op === '~') {
    emitExpr(expr.expr, e);
    e.buf.add('NOT R0,R0');
    return;
  }
  // '!' — logical not, produces 0/1: result is 1 iff the operand is zero,
  // so we boolify on the OPPOSITE of "zero", i.e. branch away when nonzero.
  emitExpr(expr.expr, e);
  e.buf.add('ADD R0,R0,#0');
  emitBoolify(e, 'BRnp');
}

// Prefix ++x/--x: load, add, store; value is the new value (already in R0
// after the add). Postfix x++/x--: load, spill old value to a temp, add,
// store, value is the saved temporary.
//
// Increment and decrement on a bool first apply integer arithmetic, then
// convert the new value back to bool, so the STORED result
// canonicalizes (value != 0 -> 1). The postfix EXPRESSION value stays the old
// value, which is already canonical because the operand was a bool. The int
// path stores the arithmetic result directly.
//
// emitIncDec computes `delta` once through incDecDelta and shares it with the
// general lvalue path below. A pointer identifier, including a decayed
// two-dimensional-array parameter, needs the same pointee-sized step as any
// other pointer lvalue. `delta` flows through chainedAdd/chainedAddFrom rather
// than a bare ADD, so a scalar's |delta| = 1 emits one instruction while a
// pointer's wider stride is split into encodable immediate chunks. Both paths
// therefore preserve the source type's increment semantics.
function emitIncDecSymbol(expr: Unary, sym: VarSymbol, delta: number, e: FrameEmit): void {
  const isBool = sym.type === 'bool';
  emitLoad(0, sym, e.buf, e.fn);
  if (expr.fix === 'post') {
    const t = e.fn.temps.push();
    // R3 invariant for far stores: value in R0, R1/R2/R3
    // all free here — nothing has been computed yet but the old value itself.
    emitStoreTemp(0, t, e.frame, e.fn, e.buf);
    if (isBool) {
      // Old value is safely in the temp, so R0 is free to hold the new value.
      for (const line of chainedAdd('R0', delta)) e.buf.add(line);
      emitConvertToBool(e);
      // R3 invariant: value in R0, R1/R2/R3 all free.
      emitStore(0, sym, e.buf, e.fn);
    } else {
      for (const line of chainedAddFrom('R1', 'R0', delta)) e.buf.add(line);
      // R3 invariant: value in R1 (R0's old copy is dead by now), R2/R3 free.
      emitStore(1, sym, e.buf, e.fn);
    }
    emitLoadTemp(0, t, e.frame, e.fn, e.buf);
    e.fn.temps.pop();
  } else {
    for (const line of chainedAdd('R0', delta)) e.buf.add(line);
    if (isBool) emitConvertToBool(e);
    // R3 invariant: value in R0, R1/R2/R3 all free.
    emitStore(0, sym, e.buf, e.fn);
  }
}

// The delta a ++ or -- applies. On a pointer this is the pointee's word
// size, not 1; for int and char that is 1, and it can be greater for
// the internal pointer-to-array type a 2D array parameter decays to and for a
// pointer to a multiword complete struct.
function incDecDelta(type: CType, op: '++' | '--'): number {
  const pointee = isPointer(type) ? type.to : null;
  const step = pointee === null ? 1 : sizeInWords(pointee);
  return op === '++' ? step : -step;
}

// Every Ident uses the symbol fast path regardless of whether its frame
// offset fits LDR/STR directly. emitLoad and emitStore already select their
// near or far encoding, so routing a far Ident through the general address
// path would duplicate that decision and change the established sequence.
// emitIncDecSymbol also accepts the type-scaled, immediate-chunked delta,
// which makes the path correct for scalar and pointer identifiers alike.
// Therefore the guard depends only on `target.kind === 'Ident'`, matching
// emitAssignToSymbol. Deref, Subscript, and Member targets require the
// general address-register path because their address is computed at run
// time.
function emitIncDec(expr: Unary, e: FrameEmit): void {
  const target = expr.expr;
  const sym = target.kind === 'Ident' ? resolvedOf(target) : null;
  const type = sym !== null ? sym.type : lvalueTypeOf(target);
  const delta = incDecDelta(type, expr.op === '++' ? '++' : '--');

  if (sym !== null) {
    emitIncDecSymbol(expr, sym, delta, e);
    return;
  }

  // General lvalue (Deref/Subscript/Member): base ONCE and keep it in a temp
  // across the whole operation. Evaluating the target twice would advance
  // `i` twice in `a[i++]++`, which is a real semantic bug, not a
  // performance question.
  const accessOffset = emitLvalueBaseAndOffset(target, e);
  const addrT = e.fn.temps.push();
  emitStoreTemp(0, addrT, e.frame, e.fn, e.buf);
  e.buf.add(`LDR R0,R0,#${accessOffset}`); // old value, through the base still in R0

  if (expr.fix === 'post') {
    const oldT = e.fn.temps.push();
    emitStoreTemp(0, oldT, e.frame, e.fn, e.buf);
    for (const line of chainedAdd('R0', delta)) e.buf.add(line);
    if (type === 'bool') emitConvertToBool(e);
    emitLoadTemp(1, addrT, e.frame, e.fn, e.buf);
    e.buf.add(`STR R0,R1,#${accessOffset}`);
    emitLoadTemp(0, oldT, e.frame, e.fn, e.buf);
    e.fn.temps.pop(); // oldT
    e.fn.temps.pop(); // addrT
    return;
  }

  for (const line of chainedAdd('R0', delta)) e.buf.add(line);
  if (type === 'bool') emitConvertToBool(e);
  emitLoadTemp(1, addrT, e.frame, e.fn, e.buf);
  e.buf.add(`STR R0,R1,#${accessOffset}`);
  e.fn.temps.pop();
}

// General branch-on-opposite "boolify": given a value already tested (its
// CC set), branches on `oppositeBranch` to the false path, falls through to
// set 1, jumps past the false path which sets 0. Used by comparisons, `!`,
// and short-circuit && / ||.
function emitBoolify(e: FrameEmit, oppositeBranch: string): void {
  const falseLabel = e.fn.nextLabel();
  const doneLabel = e.fn.nextLabel();
  e.buf.add(`${oppositeBranch} ${falseLabel}`);
  e.buf.add('AND R0,R0,#0');
  e.buf.add('ADD R0,R0,#1');
  e.buf.add(`BR ${doneLabel}`);
  e.buf.add(falseLabel);
  e.buf.add('AND R0,R0,#0');
  e.buf.add(doneLabel);
}

const COMPARE_BRANCH: Record<string, string> = {
  '<': 'BRn',
  '<=': 'BRnz',
  '>': 'BRp',
  '>=': 'BRzp',
  '==': 'BRz',
  '!=': 'BRnp',
};

function isComparison(op: BinaryOp): boolean {
  return op in COMPARE_BRANCH;
}

// A value CONVERTED TO bool must canonicalize to 0/1 — book
// section 12.2.1 (a bool holds only 0 or 1; converting a scalar yields
// value != 0). An expression that already produces 0/1 by construction — a
// comparison, a logical &&/||, a `!`, or the literals 0/1 (true/false parse to
// those) — needs no convert. Skipping it keeps a bool target compiled from a
// comparison byte-for-byte identical to the same int target (no redundant
// work), and never touches the comparison/logical canon those emitters own.
function isCanonicalBool(expr: Expr): boolean {
  if (expr.kind === 'IntLit') return expr.value === 0 || expr.value === 1;
  if (expr.kind === 'Unary') return expr.op === '!';
  if (expr.kind === 'Binary') return isComparison(expr.op) || expr.op === '&&' || expr.op === '||';
  return false;
}

// Normalizes whatever is in R0 to 0 (if zero) or 1 (if nonzero) via the shared
// boolify: test R0, then take the zero path exactly when it IS zero.
function emitConvertToBool(e: FrameEmit): void {
  e.buf.add('ADD R0,R0,#0');
  emitBoolify(e, 'BRz');
}

// Evaluates `expr` into R0 as a bool value: normal expression codegen, then a
// convert unless the value is already a canonical 0/1.
function emitValueAsBool(expr: Expr, e: FrameEmit): void {
  emitExpr(expr, e);
  if (!isCanonicalBool(expr)) emitConvertToBool(e);
}

// Evaluates `expr` into R0 for storage into a target of the given type: a bool
// target canonicalizes, while every other type is a plain move.
function emitValueForTarget(expr: Expr, type: CType, e: FrameEmit): void {
  if (type === 'bool') emitValueAsBool(expr, e);
  else emitExpr(expr, e);
}

const COMPARE_OPPOSITE: Record<string, string> = {
  BRn: 'BRzp',
  BRnz: 'BRp',
  BRp: 'BRnz',
  BRzp: 'BRn',
  BRz: 'BRnp',
  BRnp: 'BRz',
};

// R1 = left, R0 = right -> R0 = 0/1. R2 is free scratch.
//
// == / != form the wrapped difference and boolify off its zero flag: the diff
// is zero iff the operands are equal, which is safe regardless of overflow.
function emitEqualityCombine(op: BinaryOp, e: FrameEmit): void {
  e.buf.add('NOT R0,R0');
  e.buf.add('ADD R0,R0,#1');
  e.buf.add('ADD R2,R1,R0');
  e.buf.add('ADD R0,R2,#0'); // move diff into R0 so emitBoolify's test/CC applies to it
  emitBoolify(e, COMPARE_OPPOSITE[COMPARE_BRANCH[op]]);
}

// R1 = left, R0 = right -> R0 = 0/1 for a relational operator. A
// plain left-right subtract is only a valid comparison when the
// difference fits in a 16-bit word (Fig 13.7's shortcut holds only for its
// bounded example), so sign-split first: when the operand signs differ the
// negative one is the smaller, decided from the sign bits with no subtraction;
// when the signs match the difference cannot overflow, so fall into the
// unchanged subtract-and-branch. Ch 12 section 12.3.6 orders by int value.
function emitRelationalCombine(op: BinaryOp, e: FrameEmit): void {
  const leftNeg = e.fn.nextLabel();
  const sameSign = e.fn.nextLabel();
  const setTrue = e.fn.nextLabel();
  const setFalse = e.fn.nextLabel();
  const done = e.fn.nextLabel();
  const trueWhenLeftSmaller = op === '<' || op === '<=';

  // Test left's sign, then right's, and route the cross-sign cases straight
  // to the result. Both same-sign cases reach sameSign.
  e.buf.add('ADD R2,R1,#0'); // set CC from left (R1); R1/R0 preserved
  e.buf.add(`BRn ${leftNeg}`);
  // left >= 0: if right < 0, left is the larger operand.
  e.buf.add('ADD R2,R0,#0');
  e.buf.add(`BRn ${trueWhenLeftSmaller ? setFalse : setTrue}`);
  e.buf.add(`BR ${sameSign}`); // both >= 0
  e.buf.add(leftNeg);
  // left < 0: if right >= 0, left is the smaller operand.
  e.buf.add('ADD R2,R0,#0');
  e.buf.add(`BRzp ${trueWhenLeftSmaller ? setTrue : setFalse}`);
  // else both < 0: fall through into the same-sign subtract.
  e.buf.add(sameSign);
  e.buf.add('NOT R0,R0');
  e.buf.add('ADD R0,R0,#1');
  e.buf.add('ADD R2,R1,R0');
  e.buf.add('ADD R0,R2,#0'); // diff into R0 for the branch test
  e.buf.add(`${COMPARE_OPPOSITE[COMPARE_BRANCH[op]]} ${setFalse}`);
  e.buf.add(setTrue);
  e.buf.add('AND R0,R0,#0');
  e.buf.add('ADD R0,R0,#1');
  e.buf.add(`BR ${done}`);
  e.buf.add(setFalse);
  e.buf.add('AND R0,R0,#0');
  e.buf.add(done);
}

function emitCompareCombine(op: BinaryOp, e: FrameEmit): void {
  if (op === '==' || op === '!=') {
    emitEqualityCombine(op, e);
    return;
  }
  emitRelationalCombine(op, e);
}

// R0 |= via De Morgan (LC-3 has AND/NOT, no native OR): A|B = ~(~A & ~B).
function emitOrCombine(e: FrameEmit): void {
  e.buf.add('NOT R2,R1');
  e.buf.add('NOT R3,R0');
  e.buf.add('AND R0,R2,R3');
  e.buf.add('NOT R0,R0');
}

// A^B = ~(~(A&~B) & ~(~A&B)) — same De Morgan trick, one level deeper.
function emitXorCombine(e: FrameEmit): void {
  e.buf.add('NOT R2,R0'); // R2 = ~B
  e.buf.add('AND R2,R1,R2'); // R2 = A & ~B
  e.buf.add('NOT R3,R1'); // R3 = ~A
  e.buf.add('AND R3,R3,R0'); // R3 = ~A & B
  e.buf.add('NOT R2,R2');
  e.buf.add('NOT R3,R3');
  e.buf.add('AND R0,R2,R3');
  e.buf.add('NOT R0,R0');
}

// An operator runtime call combines R1 (left) and R0 (right) through the named
// entry and leaves the result in R0. It uses the same sequence as an evaluated
// two-argument function call: decrement-then-store pushes place the right
// operand first and the left operand at R5+4, followed by JSR, a result load
// from the return-value slot, and one ADD that pops the slot plus two operands
// (1 + 2 = 3). A student therefore sees the same stack protocol for ordinary
// calls and arithmetic runtime helpers.
//
// The cleanup ADD receives the same 'call'-kind lineMap carve-out as emitCall,
// so a stepper skips bookkeeping consistently for `f(x, y)` and `x * y`.
// Push, JSR, and result-load lines remain expression code on the surrounding
// statement's source line. An operator always consumes its result, so there is
// no `resultUsed` branch here.
//
// Operator sections use `JSR RTMUL`-shaped targets rather than `JSR F_<name>`.
// Because the ordinary splice scan cannot discover those targets, emitOpCall
// registers their section keys explicitly when it emits the JSR.
function emitOpCall(entry: 'RTMUL' | 'RTDIV' | 'RTMOD', sectionKey: string, e: FrameEmit): void {
  e.fn.registerOpSection(sectionKey);
  e.buf.add('ADD R6,R6,#-1');
  e.buf.add('STR R0,R6,#0');
  e.buf.add('ADD R6,R6,#-1');
  e.buf.add('STR R1,R6,#0');
  e.buf.add(`JSR ${entry}`);
  e.buf.add('LDR R0,R6,#0');
  const cleanupStart = e.buf.nextLineNo;
  e.buf.add('ADD R6,R6,#3');
  e.buf.entry(e.fn.currentCLine, 'call', cleanupStart, e.buf.lastLineNo);
}

// Counted self-ADD loop: value doubles once per count, with 16-bit wraparound
// supplied by the hardware ADD. int16.ts's shiftLeft16 is the executable
// specification for this loop. The fold-versus-runtime grid pins
// their agreement. count <= 0 leaves the value unchanged;
// count >= 16 drives it to 0.
function emitShiftLeftCombine(e: FrameEmit): void {
  const loop = e.fn.nextLabel();
  const done = e.fn.nextLabel();
  e.buf.add(loop);
  e.buf.add('ADD R0,R0,#0');
  e.buf.add(`BRnz ${done}`);
  e.buf.add('ADD R1,R1,R1');
  e.buf.add('ADD R0,R0,#-1');
  e.buf.add(`BR ${loop}`);
  e.buf.add(done);
  e.buf.add('ADD R0,R1,#0');
}

// Arithmetic, sign-preserving reconstruction runs once per count. It rebuilds
// the shifted value bit by bit from the sign bit down and copies the sign into
// the vacated high position. int16.ts's shiftRight16 is the executable
// specification for this loop. The fold-versus-runtime grid pins their
// bit-for-bit agreement. count <= 0 leaves the value
// unchanged, while count >= 16 sign-fills to 0 or -1.
function emitShiftRightCombine(e: FrameEmit): void {
  const outerTop = e.fn.nextLabel();
  const outerDone = e.fn.nextLabel();
  const bit1Set = e.fn.nextLabel();
  const bit1Done = e.fn.nextLabel();
  const bit2Set = e.fn.nextLabel();
  const bit2Done = e.fn.nextLabel();
  const innerLoop = e.fn.nextLabel();
  const innerBitSet = e.fn.nextLabel();
  const innerBitDone = e.fn.nextLabel();

  e.buf.add(outerTop);
  e.buf.add('ADD R0,R0,#0');
  e.buf.add(`BRnz ${outerDone}`);
  // One arithmetic right shift of R1, using R2 as a doubling working copy.
  e.buf.add('ADD R2,R1,#0');
  e.buf.add('ADD R2,R2,#0');
  e.buf.add(`BRn ${bit1Set}`);
  e.buf.add('AND R1,R1,#0');
  e.buf.add(`BR ${bit1Done}`);
  e.buf.add(bit1Set);
  e.buf.add('AND R1,R1,#0');
  e.buf.add('ADD R1,R1,#1');
  e.buf.add(bit1Done);
  e.buf.add('ADD R1,R1,R1');
  e.buf.add('ADD R2,R2,#0');
  e.buf.add(`BRn ${bit2Set}`);
  e.buf.add(`BR ${bit2Done}`);
  e.buf.add(bit2Set);
  e.buf.add('ADD R1,R1,#1');
  e.buf.add(bit2Done);
  e.buf.add('AND R3,R3,#0');
  e.buf.add('ADD R3,R3,#14');
  e.buf.add(innerLoop);
  e.buf.add('ADD R2,R2,R2');
  e.buf.add(`BRn ${innerBitSet}`);
  e.buf.add('ADD R1,R1,R1');
  e.buf.add(`BR ${innerBitDone}`);
  e.buf.add(innerBitSet);
  e.buf.add('ADD R1,R1,R1');
  e.buf.add('ADD R1,R1,#1');
  e.buf.add(innerBitDone);
  e.buf.add('ADD R3,R3,#-1');
  e.buf.add(`BRp ${innerLoop}`);
  e.buf.add('ADD R0,R0,#-1');
  e.buf.add(`BR ${outerTop}`);
  e.buf.add(outerDone);
  e.buf.add('ADD R0,R1,#0');
}

// Combines R1 (left) and R0 (right), leaving the result in R0. Shared by
// general Binary emission and compound-assignment fixup.
function emitCombine(op: BinaryOp, e: FrameEmit): void {
  switch (op) {
    case '+':
      e.buf.add('ADD R0,R1,R0');
      return;
    case '-':
      e.buf.add('NOT R0,R0');
      e.buf.add('ADD R0,R0,#1');
      e.buf.add('ADD R0,R1,R0');
      return;
    case '&':
      e.buf.add('AND R0,R1,R0');
      return;
    case '|':
      emitOrCombine(e);
      return;
    case '^':
      emitXorCombine(e);
      return;
    case '*':
      emitOpCall('RTMUL', 'op-mul', e);
      return;
    case '/':
      emitOpCall('RTDIV', 'op-divmod', e);
      return;
    case '%':
      emitOpCall('RTMOD', 'op-divmod', e);
      return;
    case '<<':
      emitShiftLeftCombine(e);
      return;
    case '>>':
      emitShiftRightCombine(e);
      return;
    default:
      if (isComparison(op)) {
        emitCompareCombine(op, e);
        return;
      }
      throw new Error(`emitCombine: unexpected op '${op}' (&&/|| are handled in emitBinary)`);
  }
}

// Left into R0, spill, right into R0, reload left into R1, combine. `scale`
// is checkPointerBinary's stamp (pointer arithmetic's integer operand scales
// by the pointee's word size) — codegen never re-derives which
// operand that is, it reads `scaleLeft` off the same stamp. The scale is
// applied right where that operand is freshly in R0, before it either gets
// spilled (the left operand) or combined (the right operand), so evaluation
// stays left-to-right regardless of which side is the integer.
// Both stamps are undefined for every non-pointer Binary, so emitScaleBy is
// skipped and ordinary integer operators use the unscaled sequence.
function emitLeftRightThenCombine(
  left: Expr,
  right: Expr,
  op: BinaryOp,
  e: FrameEmit,
  scale?: number,
  scaleLeft?: boolean,
): void {
  emitExpr(left, e);
  if (scale !== undefined && scaleLeft) emitScaleBy(scale, e);
  const t = e.fn.temps.push();
  emitStoreTemp(0, t, e.frame, e.fn, e.buf);
  emitExpr(right, e);
  if (scale !== undefined && !scaleLeft) emitScaleBy(scale, e);
  emitLoadTemp(1, t, e.frame, e.fn, e.buf);
  e.fn.temps.pop();
  emitCombine(op, e);
}

function emitBinary(expr: Binary, e: FrameEmit): void {
  if (expr.op === '&&') {
    emitShortCircuitAnd(expr, e);
    return;
  }
  if (expr.op === '||') {
    emitShortCircuitOr(expr, e);
    return;
  }
  emitLeftRightThenCombine(expr.left, expr.right, expr.op, e, expr.pointerScale, expr.scaleLeft);
}

function emitShortCircuitAnd(expr: Binary, e: FrameEmit): void {
  const falseLabel = e.fn.nextLabel();
  const doneLabel = e.fn.nextLabel();
  emitExpr(expr.left, e);
  e.buf.add('ADD R0,R0,#0');
  e.buf.add(`BRz ${falseLabel}`);
  emitExpr(expr.right, e);
  e.buf.add('ADD R0,R0,#0');
  e.buf.add(`BRz ${falseLabel}`);
  e.buf.add('AND R0,R0,#0');
  e.buf.add('ADD R0,R0,#1');
  e.buf.add(`BR ${doneLabel}`);
  e.buf.add(falseLabel);
  e.buf.add('AND R0,R0,#0');
  e.buf.add(doneLabel);
}

function emitShortCircuitOr(expr: Binary, e: FrameEmit): void {
  const trueLabel = e.fn.nextLabel();
  const doneLabel = e.fn.nextLabel();
  emitExpr(expr.left, e);
  e.buf.add('ADD R0,R0,#0');
  e.buf.add(`BRnp ${trueLabel}`);
  emitExpr(expr.right, e);
  e.buf.add('ADD R0,R0,#0');
  e.buf.add(`BRnp ${trueLabel}`);
  e.buf.add('AND R0,R0,#0');
  e.buf.add(`BR ${doneLabel}`);
  e.buf.add(trueLabel);
  e.buf.add('AND R0,R0,#0');
  e.buf.add('ADD R0,R0,#1');
  e.buf.add(doneLabel);
}

function compoundBinaryOp(op: AssignOp): BinaryOp {
  return op.slice(0, -1) as BinaryOp;
}

function emitAssign(expr: Assign, e: FrameEmit): void {
  // FAST PATH: an identifier's offset is always a compile-time constant.
  // emitAssignToSymbol delegates to emitStore, which selects the near or far
  // form. Keeping every Ident on this path preserves the stable far-store
  // sequence (`LD R3,.../ADD R3,.../STR R0,R3,#0`) and avoids materializing
  // an address in the general lvalue path. The decision must not depend on
  // offsetFitsLdr because emitStore already owns that encoding boundary.
  // Deref, Subscript, and Member targets instead require a runtime-computed
  // address and therefore use emitAssignThroughAddress below. This division
  // gives each target kind one address calculation and one store.
  if (expr.target.kind === 'Ident') {
    emitAssignToSymbol(expr, resolvedOf(expr.target), e);
    return;
  }
  emitAssignThroughAddress(expr, e);
}

// The symbol parameter carries the exact binding resolved by checking; this
// function does not look it up again from expr.target. For compound assignment,
// the Assign node's pointerScale stamp supplies the pointee word size. Thus
// `g += 1` on a pointer advances by one pointee rather than one word.
// Compound assignment is not a Binary node, so checkAssign records this stamp
// directly on Assign instead of using checkPointerBinary's Binary stamp.
// Both forms consume checker-owned scale metadata without deriving it again.
function emitAssignToSymbol(expr: Assign, sym: VarSymbol, e: FrameEmit): void {
  if (expr.op === '=') {
    emitValueForTarget(expr.value, sym.type, e);
    // R3 invariant for far stores: value in R0, R1/R2/R3
    // all free — expression codegen leaves everything but R0 dead.
    emitStore(0, sym, e.buf, e.fn);
    return;
  }
  emitLoad(1, sym, e.buf, e.fn);
  const t = e.fn.temps.push();
  // R3 invariant: value in R1, R2/R3 free.
  emitStoreTemp(1, t, e.frame, e.fn, e.buf);
  emitExpr(expr.value, e);
  // R1 is free here (the old value is safely in the temp, not yet reloaded),
  // so emitScaleBy's own R1 scratch use is safe — same placement rule as
  // emitLeftRightThenCombine's right-operand scale.
  if (expr.pointerScale !== undefined) emitScaleBy(expr.pointerScale, e);
  emitLoadTemp(1, t, e.frame, e.fn, e.buf);
  e.fn.temps.pop();
  emitCombine(compoundBinaryOp(expr.op), e);
  // A compound assignment (`b += 3`) computes an int result that is then
  // stored back into its bool target — the store is a conversion to bool.
  if (sym.type === 'bool') emitConvertToBool(e);
  // R3 invariant: value in R0, R1/R2/R3 all free.
  emitStore(0, sym, e.buf, e.fn);
}

// Address once, keep it in a temp across the whole operation. The
// single-evaluation discipline is a CORRECTNESS requirement, not a nicety:
// `a[i++] += 1` must advance i exactly once.
function emitAssignThroughAddress(expr: Assign, e: FrameEmit): void {
  const targetType = lvalueTypeOf(expr.target);
  const accessOffset = emitLvalueBaseAndOffset(expr.target, e);
  const addrT = e.fn.temps.push();
  emitStoreTemp(0, addrT, e.frame, e.fn, e.buf);
  if (expr.op !== '=') {
    e.buf.add(`LDR R0,R0,#${accessOffset}`); // old value, through the base still in R0
    const oldT = e.fn.temps.push();
    emitStoreTemp(0, oldT, e.frame, e.fn, e.buf);
    emitExpr(expr.value, e);
    // Same pointerScale stamp as emitAssignToSymbol, for a Deref/Subscript/Member
    // target (e.g. `*pp += 1;` where pp is a pointer to a pointer-to-row).
    // R1 is free here (the old value is in oldT, not yet reloaded).
    if (expr.pointerScale !== undefined) emitScaleBy(expr.pointerScale, e);
    emitLoadTemp(1, oldT, e.frame, e.fn, e.buf);
    e.fn.temps.pop();
    emitCombine(compoundBinaryOp(expr.op), e);
    if (targetType === 'bool') emitConvertToBool(e);
  } else {
    emitValueForTarget(expr.value, targetType, e);
  }
  emitLoadTemp(1, addrT, e.frame, e.fn, e.buf);
  e.fn.temps.pop();
  e.buf.add(`STR R0,R1,#${accessOffset}`);
}

function emitTernary(expr: { cond: Expr; then: Expr; else: Expr }, e: FrameEmit): void {
  const elseLabel = e.fn.nextLabel();
  const doneLabel = e.fn.nextLabel();
  emitExpr(expr.cond, e);
  e.buf.add('ADD R0,R0,#0');
  e.buf.add(`BRz ${elseLabel}`);
  emitExpr(expr.then, e);
  e.buf.add(`BR ${doneLabel}`);
  e.buf.add(elseLabel);
  emitExpr(expr.else, e);
  e.buf.add(doneLabel);
}

// Caller side of the calling convention: arguments are
// evaluated and pushed RIGHT-TO-LEFT (rightmost first), each push a
// decrement-then-store, so the LEFTMOST argument ends up on top of the
// stack — this is load-bearing for the callee's fixed R5+4.. offsets
// (leftmost/first param at R5+4) and for printf's variadic format-string
// pointer always landing on top regardless of arity (Fig 18.3). A string
// literal argument (printf's format string) uses the standard pooling path;
// see the position-0 guard below for why that pooling is
// confined to argument 0.
//
// `resultUsed` decides whether the cleanup sequence bothers loading the
// return value into R0 before popping the frame — false for a call used
// only for its side effects (a bare `f();` statement, or a for-loop
// init/update expression that happens to be a call), matching the caller
// cleanup's own "if the result is used" rule. Every call
// site still performs the pop regardless (return value slot + all pushed
// arguments), because the stack must balance whether or not anyone reads
// the result.
//
// The cleanup ADD is carved out as its own 'call'-kind lineMap entry (see
// wrapEntry at the call sites in emitExprStmt/emitVarDeclStmt/etc.) so
// source-level stepping can skip it — it is bookkeeping, not a C statement a
// student is "on" when execution passes through it.
function emitCall(expr: Call, e: FrameEmit, resultUsed: boolean): void {
  for (let i = expr.args.length - 1; i >= 0; i--) {
    const arg = expr.args[i];
    if (arg.kind === 'StrLit') {
      // A string literal reaching a CALL is legal only as printf's/scanf's
      // format argument (features.ts's STRING_LITERAL_CONTEXT), always
      // position 0 of a call to one of those two names. A char array's
      // initializer is the other legal context, but that
      // is handled directly by emitVarDeclStmt/emitGlobalsSection and never
      // reaches a call either way. check.ts's checkCall
      // enforces this for every user-visible path (a StrLit anywhere else
      // fails through checkExpr's allowStrLit=false branch), so a StrLit
      // reaching here at any other position, or at position 0 of a call to
      // anything but printf/scanf, is a checker bug, not a program codegen
      // must cope with — surfacing it loudly matters because poolString gives
      // identical literals one shared, WRITABLE .STRINGZ: silently pooling a
      // StrLit as a general pointer argument (e.g. `strcpy(buf, "hi")`) would
      // let a later write through that pointer corrupt every other `"hi"`
      // literal in the program.
      if (i !== 0 || (expr.callee !== 'printf' && expr.callee !== 'scanf')) {
        throw new Error(
          'codegen: a string literal argument outside position 0 of printf/scanf (checker-enforced)',
        );
      }
      const ptrLabel = e.fn.poolString(arg.value);
      e.buf.add(`LD R0,${ptrLabel}`);
    } else if (e.fn.calleeParamType(expr.callee, i) === 'bool') {
      // Passing a value to a bool parameter is a conversion to bool.
      emitValueAsBool(arg, e);
    } else {
      emitExpr(arg, e);
    }
    e.buf.add('ADD R6,R6,#-1');
    e.buf.add('STR R0,R6,#0');
  }
  e.buf.add(`JSR ${e.fn.calleeLabel(expr.callee)}`);
  if (resultUsed) e.buf.add('LDR R0,R6,#0');

  const cleanupStart = e.buf.nextLineNo;
  for (const line of chainedAdd('R6', 1 + expr.args.length)) e.buf.add(line);
  e.buf.entry(e.fn.currentCLine, 'call', cleanupStart, e.buf.lastLineNo);
}

// Used wherever an expression's value is legally computed and discarded (a
// bare expression-statement, a for-loop's init/update slot): a Call in that
// position skips the result load (see emitCall's `resultUsed`) instead of
// routing through the general emitExpr, which always assumes its caller
// wants the value in R0.
function emitExprDiscardResult(expr: Expr, e: FrameEmit): void {
  if (expr.kind === 'Cast') {
    // A type-only cast cannot turn a discarded call result into a used one.
    // Recurse through any legal cast chain before applying Call's no-load
    // path, preserving byte identity with the uncast expression.
    emitExprDiscardResult(expr.expr, e);
    return;
  }
  if (expr.kind === 'Call') {
    emitCall(expr, e, false);
    return;
  }
  emitExpr(expr, e);
}

// =========================================================================
// Statement codegen — each Stmt contributes its own lineMap entry/entries.
// =========================================================================

function commentHeader(cLine: number, prog: ProgCtx): string {
  return `; C line ${cLine}: ${trimSourceLine(prog.sourceLines, cLine)}`;
}

function emitStmt(stmt: Stmt, e: FrameEmit, prog: ProgCtx): void {
  switch (stmt.kind) {
    case 'Block':
      emitBlockStmts(stmt, e, prog);
      return;
    case 'VarDecl':
      emitVarDeclStmt(stmt, e, prog);
      return;
    case 'ExprStmt':
      emitExprStmt(stmt.expr, stmt.line, e, prog);
      return;
    case 'If':
      emitIf(stmt, e, prog);
      return;
    case 'While':
      emitWhile(stmt, e, prog);
      return;
    case 'DoWhile':
      emitDoWhile(stmt, e, prog);
      return;
    case 'For':
      emitFor(stmt, e, prog);
      return;
    case 'Switch':
      emitSwitch(stmt, e, prog);
      return;
    case 'Return':
      emitReturn(stmt, e, prog);
      return;
    case 'Break':
      emitBreak(stmt, e);
      return;
    case 'Continue':
      emitContinue(stmt, e);
      return;
  }
}

function emitBlockStmts(block: Block, e: FrameEmit, prog: ProgCtx): void {
  for (const s of block.stmts) emitStmt(s, e, prog);
}

// A local char array's string-literal initializer follows C's rule that an
// initialized aggregate is fully initialized. This is distinct from an
// uninitialized local array, whose contents remain unspecified. The padded
// text lives in an unshared data blob from FnCtx.addLocalStringInit rather
// than poolString's shared .STRINGZ, because writes through the array must not
// alter another occurrence of the same literal. A short counted copy loop
// avoids expanding a large array initializer into hundreds of straight-line
// stores. R0-R3 are dead on statement entry and form this generator's normal
// scratch set, so the copy needs no additional spill slot.
//
// `sym.initWords` is the authoritative word sequence. checkStringArrayInit
// includes the terminator and padding there, and codegen consumes its length
// without deriving the size from the type again. emitVarDeclStmt calls this
// helper only for an array with a string initializer, and accepted arrays have
// initWords populated by checking. The guard below converts any violated
// checker-to-codegen contract into an explicit internal error instead of
// running the copy with a wrong word count.
function emitStringArrayLocalInit(text: string, sym: VarSymbol, e: FrameEmit): void {
  if (sym.initWords === undefined) {
    throw new Error(
      `codegen: local '${sym.name}' has a string-literal initializer but no initWords (checker bug)`,
    );
  }
  const words = sym.initWords.length;
  const label = e.fn.addLocalStringInit(text, words, sym.name);
  emitAddressOfSymbol(0, sym, e); // dest address -> R0
  e.buf.add(`LD R1,${e.fn.poolLabelAddress(label)}`); // src address -> R1
  emitConstant(2, words, e.buf, e.fn); // counter -> R2
  const loop = e.fn.nextLabel();
  e.buf.add(loop);
  e.buf.add('LDR R3,R1,#0');
  e.buf.add('STR R3,R0,#0');
  e.buf.add('ADD R0,R0,#1');
  e.buf.add('ADD R1,R1,#1');
  e.buf.add('ADD R2,R2,#-1');
  e.buf.add(`BRp ${loop}`);
}

function emitLocalInitializer(decl: VarDecl, sym: VarSymbol, e: FrameEmit): void {
  if (decl.init === undefined) return;
  if (decl.init.kind === 'StrLit' && isArray(sym.type)) {
    emitStringArrayLocalInit(decl.init.value, sym, e);
    return;
  }
  emitValueForTarget(decl.init, sym.type, e);
  emitStore(0, sym, e.buf, e.fn);
}

function emitVarDeclStmt(decl: VarDecl, e: FrameEmit, prog: ProgCtx): void {
  const sym = resolvedDeclOf(decl);
  e.fn.currentCLine = decl.line;
  const start = e.buf.nextLineNo;
  e.buf.add(commentHeader(decl.line, prog));
  const entriesBefore = e.buf.entries.length;
  emitLocalInitializer(decl, sym, e);
  wrapEntry(e.buf, decl.line, 'stmt', start, e.buf.lastLineNo, entriesBefore);
}

function emitExprStmt(expr: Expr | null, line: number, e: FrameEmit, prog: ProgCtx): void {
  e.fn.currentCLine = line;
  const start = e.buf.nextLineNo;
  e.buf.add(commentHeader(line, prog));
  const entriesBefore = e.buf.entries.length;
  if (expr) emitExprDiscardResult(expr, e);
  wrapEntry(e.buf, line, 'stmt', start, e.buf.lastLineNo, entriesBefore);
}

// Branch on the OPPOSITE of `cond` to `falseTarget`.
function emitCondBranch(cond: Expr, falseTarget: string, e: FrameEmit): void {
  emitExpr(cond, e);
  e.buf.add('ADD R0,R0,#0');
  e.buf.add(`BRz ${falseTarget}`);
}

function emitIf(stmt: If, e: FrameEmit, prog: ProgCtx): void {
  const doneLabel = e.fn.nextLabel();
  const elseLabel = stmt.else !== null ? e.fn.nextLabel() : doneLabel;

  e.fn.currentCLine = stmt.line;
  const start1 = e.buf.nextLineNo;
  e.buf.add(commentHeader(stmt.line, prog));
  const entriesBefore1 = e.buf.entries.length;
  emitCondBranch(stmt.cond, elseLabel, e);
  wrapEntry(e.buf, stmt.line, 'stmt', start1, e.buf.lastLineNo, entriesBefore1);

  emitStmt(stmt.then, e, prog);

  if (stmt.else !== null) {
    const start2 = e.buf.nextLineNo;
    e.buf.add(`BR ${doneLabel}`);
    e.buf.add(elseLabel);
    e.buf.entry(stmt.line, 'stmt', start2, e.buf.lastLineNo);

    emitStmt(stmt.else, e, prog);

    const start3 = e.buf.nextLineNo;
    e.buf.add(doneLabel);
    e.buf.entry(stmt.line, 'stmt', start3, e.buf.lastLineNo);
  } else {
    const start2 = e.buf.nextLineNo;
    e.buf.add(doneLabel);
    e.buf.entry(stmt.line, 'stmt', start2, e.buf.lastLineNo);
  }
}

function emitWhile(stmt: While, e: FrameEmit, prog: ProgCtx): void {
  const topLabel = e.fn.nextLabel();
  const doneLabel = e.fn.nextLabel();

  e.fn.currentCLine = stmt.line;
  const start1 = e.buf.nextLineNo;
  e.buf.add(topLabel);
  e.buf.add(commentHeader(stmt.line, prog));
  const entriesBefore1 = e.buf.entries.length;
  emitCondBranch(stmt.cond, doneLabel, e);
  wrapEntry(e.buf, stmt.line, 'stmt', start1, e.buf.lastLineNo, entriesBefore1);

  e.fn.breakLabels.push(doneLabel);
  e.fn.continueLabels.push(topLabel);
  emitStmt(stmt.body, e, prog);
  e.fn.breakLabels.pop();
  e.fn.continueLabels.pop();

  const start2 = e.buf.nextLineNo;
  e.buf.add(`BR ${topLabel}`);
  e.buf.add(doneLabel);
  e.buf.entry(stmt.line, 'stmt', start2, e.buf.lastLineNo);
}

function emitDoWhile(stmt: DoWhile, e: FrameEmit, prog: ProgCtx): void {
  const topLabel = e.fn.nextLabel();
  const condLabel = e.fn.nextLabel();
  const doneLabel = e.fn.nextLabel();

  const start1 = e.buf.nextLineNo;
  e.buf.add(topLabel);
  e.buf.add(commentHeader(stmt.line, prog));
  e.buf.entry(stmt.line, 'stmt', start1, e.buf.lastLineNo);

  e.fn.breakLabels.push(doneLabel);
  e.fn.continueLabels.push(condLabel);
  emitStmt(stmt.body, e, prog);
  e.fn.breakLabels.pop();
  e.fn.continueLabels.pop();

  e.fn.currentCLine = stmt.line;
  const start2 = e.buf.nextLineNo;
  e.buf.add(condLabel);
  const entriesBefore2 = e.buf.entries.length;
  emitExpr(stmt.cond, e);
  e.buf.add('ADD R0,R0,#0');
  e.buf.add(`BRz ${doneLabel}`);
  e.buf.add(`BR ${topLabel}`);
  e.buf.add(doneLabel);
  wrapEntry(e.buf, stmt.line, 'stmt', start2, e.buf.lastLineNo, entriesBefore2);
}

// The pinned two-entry shape: header owns init+test, a second entry (same
// cLine) owns update+back-branch.
function emitFor(stmt: For, e: FrameEmit, prog: ProgCtx): void {
  const topLabel = e.fn.nextLabel();
  const updateLabel = e.fn.nextLabel();
  const doneLabel = e.fn.nextLabel();

  e.fn.currentCLine = stmt.line;
  const start1 = e.buf.nextLineNo;
  e.buf.add(commentHeader(stmt.line, prog));
  const entriesBefore1 = e.buf.entries.length;
  if (stmt.init) {
    if (Array.isArray(stmt.init)) {
      for (const decl of stmt.init) {
        const sym = resolvedDeclOf(decl);
        emitLocalInitializer(decl, sym, e);
      }
    } else {
      emitExprDiscardResult(stmt.init, e);
    }
  }
  e.buf.add(topLabel);
  if (stmt.cond) emitCondBranch(stmt.cond, doneLabel, e);
  wrapEntry(e.buf, stmt.line, 'stmt', start1, e.buf.lastLineNo, entriesBefore1);

  e.fn.breakLabels.push(doneLabel);
  e.fn.continueLabels.push(updateLabel);
  emitStmt(stmt.body, e, prog);
  e.fn.breakLabels.pop();
  e.fn.continueLabels.pop();

  e.fn.currentCLine = stmt.line;
  const start2 = e.buf.nextLineNo;
  e.buf.add(updateLabel);
  const entriesBefore2 = e.buf.entries.length;
  if (stmt.update) emitExprDiscardResult(stmt.update, e);
  e.buf.add(`BR ${topLabel}`);
  e.buf.add(doneLabel);
  wrapEntry(e.buf, stmt.line, 'stmt', start2, e.buf.lastLineNo, entriesBefore2);
}

// Case labels are constant expressions — check() already validated them.
// Re-fold here (rather than emitExpr) so the label's value is emitted via
// emitConstant, which only ever touches R0: emitExpr on a Binary label would
// route through emitLeftRightThenCombine, which reloads its left operand
// into R1 — the same register the switch value is sitting in right before
// this call, so constant folding avoids clobbering it.
function foldCaseLabel(expr: Expr): number {
  const diagnostics: CcDiagnostic[] = [];
  const value = foldConstExpr(expr, diagnostics, 'a case label');
  if (value === null) {
    throw new Error('codegen: case label failed to fold — check() should have caught this');
  }
  return value;
}

function emitSwitch(stmt: Switch, e: FrameEmit, prog: ProgCtx): void {
  const doneLabel = e.fn.nextLabel();
  const caseLabels: (string | null)[] = stmt.cases.map(() => null);
  let defaultLabel: string | null = null;
  for (let i = 0; i < stmt.cases.length; i++) {
    const label = e.fn.nextLabel();
    caseLabels[i] = label;
    if (stmt.cases[i].value === null) defaultLabel = label;
  }

  e.fn.currentCLine = stmt.line;
  const start = e.buf.nextLineNo;
  e.buf.add(commentHeader(stmt.line, prog));
  const entriesBefore = e.buf.entries.length;
  emitExpr(stmt.expr, e);
  const t = e.fn.temps.push();
  // R3 invariant for far stores: value in R0, R1/R2/R3
  // all free — expression codegen leaves everything but R0 dead.
  emitStoreTemp(0, t, e.frame, e.fn, e.buf);
  for (let i = 0; i < stmt.cases.length; i++) {
    const c = stmt.cases[i];
    if (c.value === null) continue;
    emitLoadTemp(1, t, e.frame, e.fn, e.buf);
    emitConstant(0, foldCaseLabel(c.value), e.buf, e.fn);
    e.buf.add('NOT R0,R0');
    e.buf.add('ADD R0,R0,#1');
    e.buf.add('ADD R0,R1,R0');
    e.buf.add(`BRz ${caseLabels[i]}`);
  }
  e.fn.temps.pop();
  e.buf.add(`BR ${defaultLabel ?? doneLabel}`);
  wrapEntry(e.buf, stmt.line, 'stmt', start, e.buf.lastLineNo, entriesBefore);

  e.fn.breakLabels.push(doneLabel);
  for (let i = 0; i < stmt.cases.length; i++) {
    const c = stmt.cases[i];
    const labelStart = e.buf.nextLineNo;
    e.buf.add(caseLabels[i] as string);
    e.buf.entry(c.line, 'stmt', labelStart, e.buf.lastLineNo);
    for (const s of c.stmts) emitStmt(s, e, prog);
  }
  e.fn.breakLabels.pop();

  const doneStart = e.buf.nextLineNo;
  e.buf.add(doneLabel);
  e.buf.entry(stmt.line, 'stmt', doneStart, e.buf.lastLineNo);
}

// A valued return computes directly into R0, stores the result at R5+3, and
// branches to the function's shared epilogue tail. emitFunction emits that
// tail once; it pops the frame and returns without writing the result slot.
// A bare return, including one in a non-void function accepted with no value,
// skips the STR entirely. R5+3 therefore remains untouched, matching implicit
// fall-through at the end of a function.
//
// The line map separates source evaluation from frame teardown. For a valued
// return, the source comment and expression instructions form a 'stmt' entry
// where a source-level step can stop. The result store and branch form an
// 'epilogue' entry because they implement calling-convention bookkeeping.
// This gives a leaf such as `return x * x;` a statement stop inside its body
// instead of exposing only epilogue instructions. A bare return has no value
// computation, but its branch still represents the source statement and is
// therefore mapped as 'stmt', like break and continue. The shared tail remains
// 'epilogue'. This classification lets stepping enter and stop on both valued
// and bare returns without treating teardown as another C statement.
function emitReturn(stmt: Return, e: FrameEmit, prog: ProgCtx): void {
  e.fn.currentCLine = stmt.line;
  const start = e.buf.nextLineNo;
  e.buf.add(commentHeader(stmt.line, prog));
  const entriesBefore = e.buf.entries.length;
  if (stmt.expr !== undefined) {
    // Returning a value from a bool-returning function converts it to bool
    // before storage; the conversion stays inside the value-computation entry.
    emitValueForTarget(stmt.expr, e.frame.returnType, e);
    wrapEntry(e.buf, stmt.line, 'stmt', start, e.buf.lastLineNo, entriesBefore);
    const epilogueStart = e.buf.nextLineNo;
    e.buf.add('STR R0,R5,#3');
    e.buf.add(`BR ${e.fn.epilogueLabel}`);
    e.buf.entry(stmt.line, 'epilogue', epilogueStart, e.buf.lastLineNo);
    return;
  }
  e.buf.add(`BR ${e.fn.epilogueLabel}`);
  wrapEntry(e.buf, stmt.line, 'stmt', start, e.buf.lastLineNo, entriesBefore);
}

function emitBreak(stmt: Break, e: FrameEmit): void {
  const target = e.fn.breakLabels[e.fn.breakLabels.length - 1];
  if (!target) throw new Error('codegen: break outside a loop/switch (checker-enforced)');
  const start = e.buf.nextLineNo;
  e.buf.add(`BR ${target}`);
  e.buf.entry(stmt.line, 'stmt', start, e.buf.lastLineNo);
}

function emitContinue(stmt: Continue, e: FrameEmit): void {
  const target = e.fn.continueLabels[e.fn.continueLabels.length - 1];
  if (!target) throw new Error('codegen: continue outside a loop (checker-enforced)');
  const start = e.buf.nextLineNo;
  e.buf.add(`BR ${target}`);
  e.buf.entry(stmt.line, 'stmt', start, e.buf.lastLineNo);
}

// =========================================================================
// Function-level emission (two-pass: body first for the temp high-water
// mark, then the real four-action prologue sized by that final count — see
// the module header's temporary-slot ownership contract).
// =========================================================================

function capacityErr(node: { line: number; col: number }, message: string): CcDiagnostic {
  return err(node, message);
}

// Counts the original (unescaped) characters in an escapeForStringz'd
// string — each escape pair ("\\", "\"", "\n", "\t", "\r", "\0") represents
// one original character, so a backslash always consumes its following char.
function stringzCharCount(escaped: string): number {
  let count = 0;
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === '\\') i++;
    count++;
  }
  return count;
}

// A no-operand mnemonic is a single token with nothing else on the line,
// exactly the same lexical shape as a bare label. The classifier must name
// RET, HALT, and RTI explicitly so each contributes one assembled word.
// Treating any of them as a zero-word label would undercount PC-relative
// distances whenever the instruction falls inside the scanned range.
// Keep this set synchronized with zero-operand mnemonics emitted here.
const ZERO_OPERAND_MNEMONICS = new Set(['RET', 'HALT', 'RTI']);

// Classifies one emitted asm line by how many words it assembles to. This
// mirrors codegen's own emission shapes exactly (not a general assembler
// line parser): the literal-pool reach guard must measure
// WORDS (what PCoffset9 actually counts), not source LINES. Comments and
// bare-label lines (a single token, nothing else) assemble to zero words;
// a bare no-operand mnemonic (RET/HALT/RTI, same single-token shape as a
// label) is one word; .FILL is one word; .STRINGZ is (character count + 1)
// words; .BLKW is N words; anything else — a plain instruction, optionally
// with a label on the same line — is one word.
function lineWordCount(text: string): number {
  const t = text.trim();
  if (t === '' || t.startsWith(';')) return 0;
  // .ORIG/.END set/close the location counter but assemble to zero words.
  // .END is already a single bare token (caught by the zero-word branch
  // below), but .ORIG carries its origin operand, so without this branch it
  // would fall through to the final "one word" default — harmless for the
  // relative-distance reach guards (a constant +1 on both endpoints cancels)
  // but wrong for the ABSOLUTE image-end address, whose running sum starts
  // from the `.ORIG x3000` line itself.
  if (/^\.(?:ORIG|END)\b/i.test(t)) return 0;
  const stringz = t.match(/\.STRINGZ\s+"((?:\\.|[^"\\])*)"/);
  if (stringz) return stringzCharCount(stringz[1]) + 1;
  const blkw = t.match(/\.BLKW\s+(\d+)/);
  if (blkw) return parseInt(blkw[1], 10);
  if (/\.FILL\b/.test(t)) return 1;
  if (!/\s/.test(t)) return ZERO_OPERAND_MNEMONICS.has(t.toUpperCase()) ? 1 : 0;
  return 1; // an instruction, optionally prefixed with a label (JSR/JMP always carry an operand, so they never hit this branch)
}

// Parameters start at R5+4. The far-address fallbacks in emitLoadOffset and
// emitStoreOffset reach parameters outside offset6 just as they reach locals
// and temporaries. The limit of 28 is therefore a deliberate pedagogical
// bound on frame complexity, not an encoding limit imposed by the hardware.
// The diagnostic below states the supported frame contract explicitly.
const MAX_PARAMS = 28;

function emitFunction(decl: FuncDecl, frame: FuncFrame, prog: ProgCtx): void {
  if (frame.params.length > MAX_PARAMS) {
    prog.diagnostics.push(
      capacityErr(
        decl,
        `function '${frame.name}' has too many parameters (${frame.params.length}) for the LC-3 frame — offset range is R5+4 to R5+31 (${MAX_PARAMS} parameters maximum)`,
      ),
    );
    return;
  }

  // The mangled label base drives F_<base> and every name-derived
  // internal label (L_/C_/epilogue), so two functions differing only in case
  // never fold together in the assembler's case-insensitive symbol table.
  const labelBase = prog.funcLabels.get(frame.name) ?? frame.name;
  const bodyBuf = new LineBuffer();
  const fn = new FnCtx(labelBase, prog);
  const e: FrameEmit = { frame, buf: bodyBuf, fn };
  // Flush the literal pool between top-level statements once the body has run
  // on far enough that a pending LD is nearing its PCoffset9 reach.
  // Between statements only: an island inside a loop body would put a BR in the
  // hot path and read as noise on the datapath. Line count is the trigger and
  // it over-counts (comments and labels carry no word), so islands land earlier
  // than strictly needed — the safe direction. A single statement longer than
  // the margin can still overrun, and checkPcRelativeReach still reports that
  // honestly from final addresses.
  for (const s of decl.body!.stmts) {
    emitStmt(s, e, prog);
    if (bodyBuf.lastLineNo - fn.poolAnchor >= POOL_ISLAND_INTERVAL) fn.flushPoolIsland(bodyBuf);
  }

  // A local's word count can exceed one for arrays, so `total` is the complete
  // frame footprint in words: all locals plus the temporary high-water mark.
  // The prologue uses it only to reserve frame storage.
  //
  // Frames may extend beyond LDR/STR's offset6 range of -32..31. Locals
  // descend from R5+0, while temporaries sit below them at the offset returned
  // by tempOffset. emitLoadOffset and emitStoreOffset select a three-instruction
  // far form whenever a slot lies outside the direct range: load the pooled
  // offset, add it to the frame base, then use LDR/STR at #0. Consequently,
  // every frame accepted by checking has an encodable access sequence.
  // check.ts applies MAX_FRAME_WORDS to locals before codegen runs; temporary
  // storage is bounded separately by syntax depth and generated-line limits.
  // No offset6-derived slot cap belongs here because the far form covers the
  // entire accepted frame range.
  const total = localWordCount(frame) + fn.temps.highWater;

  // Shared epilogue tail (module header's calling-convention notes): every
  // explicit return already wrote R5+3 itself (emitReturn) and branches
  // here; the implicit fall-off-the-end path reaches this same label by
  // falling straight through the last body statement, having executed no
  // STR at all. This tail never touches R5+3; it performs epilogue steps
  // 2-4 only (pop locals, pop saved FP/RA, RET).
  bodyBuf.add(fn.epilogueLabel);
  const epilogueStart = bodyBuf.nextLineNo;
  bodyBuf.add('ADD R6,R5,#1');
  bodyBuf.add('LDR R5,R6,#0');
  bodyBuf.add('ADD R6,R6,#1');
  bodyBuf.add('LDR R7,R6,#0');
  bodyBuf.add('ADD R6,R6,#1');
  bodyBuf.add('RET');
  bodyBuf.entry(decl.body!.endLine, 'epilogue', epilogueStart, bodyBuf.lastLineNo);

  prog.buf.add(`F_${labelBase}`);
  prog.emittedUserLabelBases.add(labelBase);
  const prologueStart = prog.buf.nextLineNo;
  // The four-action prologue described in Chapter 14 reserves the return-value
  // slot, pushes R7, pushes R5, then sets R5 = R6-1 and reserves locals+temps. The
  // final ADD is omitted entirely (not emitted as ADD R6,R6,#0) when the
  // function has no locals or temporaries — chainedAdd(R6, 0) would
  // otherwise silently emit nothing anyway, but the explicit comment makes
  // the omission a documented choice instead of an accident.
  prog.buf.add('ADD R6,R6,#-1');
  prog.buf.add('ADD R6,R6,#-1');
  prog.buf.add('STR R7,R6,#0');
  prog.buf.add('ADD R6,R6,#-1');
  prog.buf.add('STR R5,R6,#0');
  prog.buf.add('ADD R5,R6,#-1');
  if (total > 0) {
    for (const line of chainedAdd('R6', -total)) prog.buf.add(line);
  } else {
    prog.buf.add('; no locals or temporaries to reserve');
  }
  prog.buf.entry(decl.line, 'prologue', prologueStart, prog.buf.lastLineNo);

  const offset = prog.buf.lastLineNo;
  for (const line of bodyBuf.lines) prog.buf.add(line);
  for (const entry of bodyBuf.entries) {
    prog.buf.entry(entry.cLine, entry.kind, entry.asmStart + offset, entry.asmEnd + offset);
  }

  // The remaining literal pool is placed immediately after this function's
  // body. checkPcRelativeReach validates each referencing LD, like every BR,
  // against the target's final laid-out address. Using actual program-wide
  // addresses makes the check exact for forward and backward spans and covers
  // loops, branches, calls, and pool loads uniformly. No predictive
  // per-function reach estimate is needed at this point in emission.
  // Earlier islands have already been embedded near their own users.
  if (fn.pool.length > 0) {
    const poolStart = prog.buf.nextLineNo;
    for (const p of fn.pool) prog.buf.add(`${p.label} .FILL ${p.value}`);
    prog.buf.entry(null, 'data', poolStart, prog.buf.lastLineNo);
  }

  // Each local char array initialized from a string literal gets
  // its own, unshared .STRINGZ + zero-padding block here, right after this
  // function's own literal pool — never pooled/deduped against another
  // identical literal (FnCtx.addLocalStringInit) and never placed in
  // prog.strings (poolString's own shared table). `blob.words` is already
  // length-authoritative (sourced from the local's own initWords.length,
  // see emitStringArrayLocalInit) — the throw below is the same
  // fail-loud-not-silently-short backstop emitStringArrayGlobal uses, kept
  // here at the one other site that pads a string literal out to a
  // declared array length. The padding words carry the same `; <name>`
  // comment used by a global's own padding words.
  for (const blob of fn.localStrings) {
    const blobStart = prog.buf.nextLineNo;
    prog.buf.add(`${blob.label} .STRINGZ "${escapeForStringz(blob.text)}"`);
    prog.buf.entry(null, 'data', blobStart, prog.buf.lastLineNo);
    const textWords = blob.text.length + 1;
    const padding = blob.words - textWords;
    if (padding < 0) {
      throw new Error(
        `codegen: local '${blob.name}'s string literal (${textWords} words) does not fit its declared ${blob.words} words (checker bug — should have been rejected)`,
      );
    }
    for (let i = 0; i < padding; i++) {
      const fillStart = prog.buf.nextLineNo;
      prog.buf.add(`.FILL #0 ; ${blob.name}`);
      prog.buf.entry(null, 'data', fillStart, prog.buf.lastLineNo);
    }
  }
}

// =========================================================================
// Runtime library splice. Only the sections a program uses, together with
// their transitive `needs`, are appended after every user function's own
// code and literal pool and before the global and string data sections.
// User functions therefore remain contiguous with the pools that serve their loads.
// Runtime sections stay close to the JSR instructions that call them.
// Global and string data remain at the final shared data boundary.
// This fixed ordering makes address calculations and emitted text deterministic.
// Placement also keeps call and literal-load spans short in large programs.
// Dependency discovery selects sections; RUNTIME_ORDER controls their final order.
// A program with no runtime use emits no runtime section or associated data tail.
// User functions emit first, so string literals discovered in their bodies are
// known before the data section is written — see codegen()'s own comment);
// appending the runtime immediately after keeps it as close as possible to
// the JSRs that reach it (every `JSR F_<runtimeName>` a user function
// emits), which matters for checkPcRelativeReach's PCoffset11 budget on
// large programs, and keeps each section's own internal LDs (its literal
// pool) nowhere near the growing globals/strings section, which has no size
// bound this file enforces. Splicing before the globals section rather than
// after also means a program that both declares many globals AND calls
// printf doesn't make every `JSR F_printf` reach further than necessary.
//
// Gated on actual use (collectRuntimeNames below — a scan for the exact
// `JSR F_<name>` lines emitCall produces, cheap and precise since
// emitCall's format is fixed and this file is the only producer of those
// lines, unioned with the explicitly registered operator sections) rather
// than unconditionally: unconditionally appending every section to every
// compiled program, even ones with no I/O at all, would needlessly bloat
// output and — more importantly — would change the assembly of every program
// that does not call the runtime. Per-function selection also ensures that a
// program calling only putchar does not carry printf's conversion routine.
// This matters across the full library of I/O, string, and allocation helpers.
// Selection is structural rather than an instruction-level optimization:
// once selected, a section is emitted intact and in deterministic order.
// Nothing inside a selected section is pruned or reordered.
//
// The gate's two input channels are unioned here and exported so callers
// can validate each channel and the collision guarantee directly:
//
// The scan matches against RUNTIME_SECTIONS' own keys, not RUNTIME_ORDER:
// the two are kept in sync by construction (every RUNTIME_SECTIONS key
// also appears in RUNTIME_ORDER; splice-order coverage pins that invariant),
// and a user function that happens to share a
// runtime name (blocked for all eight C-callable names — putchar/getchar/
// printf/scanf/strcmp/strcpy/malloc/free — see check.ts's registerFunction) can't
// false-positive either.
//
// The explicit channel carries the operator sections, which are
// not C functions and are never reached through a `JSR F_<name>`: their
// keys ('op-mul'/'op-divmod') are hyphenated, and no C identifier's
// mangled `F_<name>` can contain a hyphen, so the scan is immune to them
// by construction — a user's own `int mul()` legally emits `JSR F_mul`,
// which matches no RUNTIME_SECTIONS key and can never splice an operator
// section. Those sections enter a program only through `explicit`
// (ProgCtx.usedOpSections), written by emitOpCall at the moment it emits a
// JSR RTMUL/RTDIV/RTMOD. Explicit entries that are not RUNTIME_SECTIONS
// keys are ignored — the same filter the scan applies.
export function collectRuntimeNames(
  lines: readonly string[],
  explicit: ReadonlySet<string>,
  emittedUserLabelBases: ReadonlySet<string> = new Set(),
): Set<string> {
  const used = new Set<string>();
  for (const line of lines) {
    const m = /^JSR F_(.+)$/.exec(line);
    // A user function can share a base name with a runtime section. Its
    // emitted F_<base> label owns that call target, so the same call must not
    // splice a duplicate runtime definition. Filter only bases whose function
    // bodies were actually emitted. Filtering every declared function would
    // suppress builtins such as printf, whose implementation intentionally
    // comes from the runtime section.
    if (m && !emittedUserLabelBases.has(m[1]) && RUNTIME_SECTIONS.has(m[1])) {
      used.add(m[1]);
    }
  }
  for (const name of explicit) {
    if (RUNTIME_SECTIONS.has(name)) used.add(name);
  }
  return used;
}

// The transitive closure of `needs` pulls in every section required by a
// directly used helper, such as getchar for scanf, across any dependency
// depth described by RUNTIME_SECTIONS. The section map is a parameter rather
// than hidden module state, so this function is a pure transformation of its
// inputs. The transformation supports chain, diamond, and cycle-shaped maps in
// addition to the real runtime graph. The visited Set emits a shared
// dependency only once when multiple sections need it, and it terminates a
// dependency cycle without recursion. Returning a Set also gives callers a
// stable membership boundary; RUNTIME_ORDER, not discovery order, determines
// final assembly order. Missing map entries remain leaf names in this Set;
// emission considers only entries present in RUNTIME_ORDER.
export function transitiveRuntimeNames(
  direct: ReadonlySet<string>,
  sections: ReadonlyMap<string, { needs: readonly string[] }>,
): Set<string> {
  const closure = new Set<string>();
  const pending = [...direct];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || closure.has(name)) continue;
    closure.add(name);
    const section = sections.get(name);
    if (section) pending.push(...section.needs);
  }
  return closure;
}

function emitRuntimeIfNeeded(prog: ProgCtx): boolean {
  const direct = collectRuntimeNames(
    prog.buf.lines,
    prog.usedOpSections,
    prog.emittedUserLabelBases,
  );
  if (direct.size === 0) return false;
  const needed = transitiveRuntimeNames(direct, RUNTIME_SECTIONS);
  const heapRuntimeSpliced = needed.has('malloc');
  const start = prog.buf.nextLineNo;
  // RUNTIME_ORDER fixes splice order for every program that needs multiple
  // sections. Two programs calling the same runtime set therefore emit those
  // sections in the same relative order. Appending another name preserves
  // the positions of existing sections, which keeps output deterministic and
  // avoids renumbering labels already used in generated assembly.
  for (const name of RUNTIME_ORDER) {
    if (!needed.has(name)) continue;
    const section = RUNTIME_SECTIONS.get(name);
    if (!section) {
      throw new Error(
        `codegen: runtime section '${name}' is needed but not yet defined in RUNTIME_SECTIONS (compiler bug)`,
      );
    }
    for (const line of section.asm.split('\n')) prog.buf.add(line);
    // malloc's two image-specific words are codegen-owned rather
    // than static runtime text. Keep them immediately beside malloc so its
    // PCoffset9 loads remain stable even as later runtime sections append.
    if (name === 'malloc') {
      prog.buf.add(`${RTHP_BASE} .FILL ${IMAGE_END_LABEL}`);
      prog.buf.add(`${RTHP_CEIL} .FILL ${toHex4(IMAGE_LIMIT)}`);
    }
  }
  // Runtime code has no C source line of its own, so cLine is null. Executing
  // instructions receive the 'runtime' kind, while each section's trailing
  // .FILL or .STRINGZ literal pool contains true data words. Those words map
  // as 'data'. entrySplittingData scans the whole spliced
  // range so this holds however many sections were spliced or how their
  // data is arranged.
  entrySplittingData(prog.buf, 'runtime', start, prog.buf.lastLineNo);
  return heapRuntimeSpliced;
}

// =========================================================================
// Globals + string data section.
// =========================================================================

// The data section is not limited by LDR/STR's offset6 reach because far
// global access materializes larger offsets. Its capacity is instead bounded
// by the program image and this named word-count guard. The value 512 mirrors
// check.ts's MAX_FRAME_WORDS as a generous, non-offset-derived limit for a
// single storage region. Keeping the guard here produces a globals-specific
// diagnostic at the declaration that crosses the boundary instead of a later
// generic image-size error. The independent whole-image guard still covers
// code, runtime sections, strings, and globals together. This constant is a
// compiler policy limit, not an LC-3 instruction-field limit, and can change
// without altering the far-address encoding. The diagnostic below always
// reports the configured value.
const MAX_GLOBAL_WORDS = 512;

// Anchor the too-many-globals diagnostic at the first declaration whose
// cumulative footprint exceeds the limit. This is a word limit rather than a
// declaration-count limit: one array can cross the boundary by itself.
// Therefore the anchor follows the cumulative size calculation instead of a
// fixed declaration index. In an all-scalar program each declaration adds one
// word, so the first excess declaration is the one immediately after the
// configured limit.
function firstOverLimitGlobal(
  program: Program,
  symbols: SymbolTables,
): { line: number; col: number } {
  let words = 0;
  for (const g of symbols.globals) {
    words += sizeInWords(g.type);
    if (words > MAX_GLOBAL_WORDS) {
      const decl = program.decls.find((d) => d.kind === 'VarDecl' && d.name === g.name);
      if (decl) return decl;
      break;
    }
  }
  return { line: 1, col: 1 };
}

// The exact source text of a global's string-literal initializer, when it
// has one — read straight from the AST rather than re-deriving it from
// initWords' character codes, so the emitted .STRINGZ text and the
// checker's own validated text can never drift apart. Only ever consulted
// when initWords is already set (registerGlobal's own doing), which happens
// only for a validated char-array-from-string-literal global; the
// `undefined` fallback matters only if that invariant is ever violated, in
// which case the caller's own initWords-driven per-word loop below still
// emits the right words — defense in depth, not the only line of it.
function stringInitTextFor(program: Program, name: string): string | undefined {
  const decl = program.decls.find((d) => d.kind === 'VarDecl' && d.name === name);
  return decl && decl.kind === 'VarDecl' && decl.init?.kind === 'StrLit'
    ? decl.init.value
    : undefined;
}

// A global char array initialized from a string literal.
// The declared length is g.initWords.length, not the text's own length, so
// the difference is zero-padded out to the array's full declared size — C's
// "an initialized aggregate is fully initialized" rule, applied to the
// terminator and every word after it. One 'data' lineMap entry for the
// .STRINGZ word group, one per .FILL #0 padding word, matching every other
// global's own per-word-group entry shape.
//
// The padding count comes from g.initWords.length, the authoritative sequence
// produced by checkStringArrayInit. That sequence already contains the
// terminator and every required zero word, so codegen does not independently
// derive the array size from its type. emitGlobalsSection calls this helper
// only when initWords is present. The guard below makes a violated checker
// contract fail explicitly rather than silently emitting a short object.
// A short object would shift every subsequent global's address and invalidate
// symbol offsets, so preserving the authoritative length is load-bearing.
// textWords counts the emitted .STRINGZ payload plus its terminator; padding
// is the remainder of the checked sequence. A negative remainder signals an
// internal inconsistency and is rejected before output continues.
function emitStringArrayGlobal(g: VarSymbol, text: string, prog: ProgCtx): void {
  if (g.initWords === undefined) {
    throw new Error(
      `codegen: global '${g.name}' has a string-literal initializer but no initWords (checker bug)`,
    );
  }
  const totalWords = g.initWords.length;
  const textWords = text.length + 1; // the .STRINGZ line's own word count (auto-terminated)
  const padding = totalWords - textWords;
  if (padding < 0) {
    throw new Error(
      `codegen: global '${g.name}'s string literal (${textWords} words) does not fit its declared ${totalWords} words (checker bug — should have been rejected)`,
    );
  }
  const start = prog.buf.nextLineNo;
  prog.buf.add(`.STRINGZ "${escapeForStringz(text)}" ; ${g.name}`);
  prog.buf.entry(null, 'data', start, prog.buf.lastLineNo);
  for (let i = 0; i < padding; i++) {
    const fillStart = prog.buf.nextLineNo;
    prog.buf.add(`.FILL #0 ; ${g.name}`);
    prog.buf.entry(null, 'data', fillStart, prog.buf.lastLineNo);
  }
}

// `forceLabel`: crt0's `.FILL GLOBAL` pointer must always resolve to
// something once crt0 is emitted (whenever the program defines `main`),
// even if the program happens to declare zero global variables. A bare
// `GLOBAL` label with nothing after it is invalid because the assembler
// rejects any label with
// no instruction or data following it. Therefore a runnable program with no
// globals still needs storage at the GLOBAL address named by crt0. When
// forceLabel is set and both globals and pooled strings are absent, this
// section emits one deterministic placeholder word. GLOBAL then always binds
// to an assembled address.
function emitGlobalsSection(
  program: Program,
  symbols: SymbolTables,
  prog: ProgCtx,
  forceLabel: boolean,
): void {
  // The guard sums sizeInWords across every global; an array occupies
  // many words, so this is the data section's real footprint, not a count of
  // declarations. For an all-scalar program every global is exactly one
  // word, so the word total also equals the declaration count at the
  // configured threshold above.
  const totalWords = symbols.globals.reduce((sum, g) => sum + sizeInWords(g.type), 0);
  if (totalWords > MAX_GLOBAL_WORDS) {
    prog.diagnostics.push(
      capacityErr(
        firstOverLimitGlobal(program, symbols),
        `program's globals need ${totalWords} words for the LC-3 global data section, more than this compiler allows (${MAX_GLOBAL_WORDS} maximum)`,
      ),
    );
    return;
  }

  if (symbols.globals.length === 0 && prog.strings.length === 0 && !forceLabel) return;

  prog.buf.add('GLOBAL');
  if (symbols.globals.length === 0 && forceLabel) {
    const start = prog.buf.nextLineNo;
    prog.buf.add('.FILL #0 ; placeholder -- program declares no globals');
    prog.buf.entry(null, 'data', start, prog.buf.lastLineNo);
  }
  for (const g of symbols.globals) {
    const stringText = g.initWords !== undefined ? stringInitTextFor(program, g.name) : undefined;
    if (stringText !== undefined) {
      emitStringArrayGlobal(g, stringText, prog);
      continue;
    }
    const words = sizeInWords(g.type);
    const values = Array.from({ length: words }, (_, i) => g.initWords?.[i] ?? g.initValue ?? 0);
    for (const v of values) {
      const start = prog.buf.nextLineNo;
      prog.buf.add(`.FILL #${v} ; ${g.name}`);
      prog.buf.entry(null, 'data', start, prog.buf.lastLineNo);
    }
  }
}

function emitStringSection(prog: ProgCtx): void {
  for (const s of prog.strings) {
    const start = prog.buf.nextLineNo;
    prog.buf.add(`${s.label} .STRINGZ "${escapeForStringz(s.text)}"`);
    prog.buf.entry(null, 'data', start, prog.buf.lastLineNo);
  }
}

// =========================================================================
// crt0 — program entry point and stack/global bootstrap.
// =========================================================================

// Emitted first, crt0 wraps the program in its single .ORIG/.END block. It
// performs three fixed actions in order: point R4 at the global data section,
// initialize R6 to the documented stack base, and call main through the full
// caller convention. The call reserves and cleans up a return-value slot even
// though crt0 ignores the value and halts after main returns. This block is
// generated per program because it names F_main and GLOBAL. It is separate
// from RUNTIME_SECTIONS, whose reusable helpers know neither program-specific
// label name. A second .ORIG is invalid, so no runtime section emits one.
function emitCrt0(prog: ProgCtx): void {
  prog.buf.add('.ORIG x3000');
  const start = prog.buf.nextLineNo;
  prog.buf.add(
    '; crt0 (generated): initializes R4/R6 for the calling convention, calls main, halts on return.',
  );
  prog.buf.add('LD R4,CRT0_GLOBAL');
  prog.buf.add(
    '; R6 = xF000, not xEFFF: R6 always points AT the top OCCUPIED stack word (never one',
  );
  prog.buf.add(
    '; past it), and every push decrements before storing (ADD R6,R6,#-1 then STR) -- so',
  );
  prog.buf.add(
    '; the first word ever pushed lands at xEFFF, matching the book stack-base drawings.',
  );
  prog.buf.add('LD R6,CRT0_STACK');
  // The entry point keeps the readable `main` base (buildFuncLabels processes
  // it first), so this is `JSR F_main` unless an ordinary `Main` also exists.
  prog.buf.add(`JSR F_${prog.funcLabels.get('main') ?? 'main'}`);
  prog.buf.add('ADD R6,R6,#1'); // pop the return-value slot; main takes no arguments
  prog.buf.add('HALT');
  prog.buf.add('CRT0_GLOBAL .FILL GLOBAL');
  prog.buf.add('CRT0_STACK .FILL xF000');
  // The executable LD/JSR/HALT bootstrap is its own 'startup' kind,
  // not 'data': it has no C source line of its own (cLine: null) but
  // it executes. Executing instructions must retain an executing map kind
  // rather than being classified as data. Its two trailing literal
  // words (CRT0_GLOBAL/CRT0_STACK .FILL) are the inverse edge — true data
  // words that must NOT inherit 'startup' — so entrySplittingData carves them
  // out as their own 'data' entry.
  entrySplittingData(prog.buf, 'startup', start, prog.buf.lastLineNo);
}

// =========================================================================
// Program-level PC-relative relocation uses one final-address pass over the
// laid-out image. It resolves every branch (PCoffset9), PC-relative load or
// store (PCoffset9), and direct call (PCoffset11), then checks the actual span
// against the exact hardware field range enforced by the assembler. Actual
// addresses cover forward and backward loop branches, function epilogues,
// literal pools, runtime calls, and crt0's call to main with one rule.
// The pass runs only after complete layout because any source or target can
// depend on the sizes of functions, pools, and runtime sections emitted before
// it. This same finality makes the check exact: it neither assumes a worst-case
// source position nor omits an instruction class. Diagnostics attach to the
// containing function when possible and otherwise use the program entry point.
// The separate image-size guard uses the same completed layout for the memory
// partition boundary. Together they validate field reach and total footprint
// without conflating those two capacity constraints.
// =========================================================================

// Return the label a line binds to the current address, or null. Generated
// assembly has two binding shapes that mirror the assembler's first pass:
//   1. a bare label on its own line, including function and branch targets;
//   2. a label prefixed on .FILL, .STRINGZ, or .BLKW data.
// The second form includes literal-pool constants, string labels, crt0 words,
// and runtime data. Loads can target either form, so both must enter the
// address map used by PC-relative reach validation. A single-token line may
// also be a zero-operand instruction; ZERO_OPERAND_MNEMONICS distinguishes
// that instruction shape from a bare label. Multi-token generated labels
// appear only on data directives, never before instructions, so the shared
// DATA_DIRECTIVE_RE precisely covers the other binding form. Lines beginning
// with a directive or comment bind no label here. The returned spelling stays
// unchanged because assembler symbol matching owns case normalization.
function lineLabel(t: string): string | null {
  if (t === '' || t.startsWith(';') || t.startsWith('.')) return null;
  if (!/\s/.test(t)) {
    // Single token: a bare label, unless it's a zero-operand mnemonic
    // (RET/HALT/RTI — an instruction with the same single-token shape).
    return ZERO_OPERAND_MNEMONICS.has(t.toUpperCase()) ? null : t;
  }
  const m = DATA_DIRECTIVE_RE.exec(t);
  return m ? m[1] : null;
}

// Program-wide word-address table: walks buf's lines accumulating the same
// per-line word count lineWordCount already uses, recording each label's
// address as the address of the line it sits on. `.ORIG`/`.END` and comments
// count as zero words via lineWordCount.
function labelAddresses(lines: string[]): Map<string, number> {
  const addrs = new Map<string, number>();
  let addr = 0;
  for (const line of lines) {
    const label = lineLabel(line.trim());
    if (label !== null) addrs.set(label, addr);
    addr += lineWordCount(line);
  }
  return addrs;
}

// The exact signed range of an n-bit PC-relative offset is [-2^(n-1),
// 2^(n-1)-1]. PCoffset9 reaches -256..+255 and PCoffset11 reaches
// -1024..+1023, matching the assembler. This helper is the single source of
// truth for the reach check below and is exported so boundary tests can compare
// compiler acceptance directly with assembler acceptance.
export function pcOffsetFits(offset: number, bits: 9 | 11): boolean {
  const min = -(1 << (bits - 1));
  const max = (1 << (bits - 1)) - 1;
  return offset >= min && offset <= max;
}

// The three emitted asm shapes that carry a PC-relative offset to a LABEL.
// Only the label-operand forms need relocation — a numeric `#n` offset is
// already fixed at emit time (and is skipped anyway, since it never resolves
// in the label-address map). LDR/STR are base+offset6 (register form), and
// JSRR takes a register, so none of them are PC-relative.
const BRANCH_LABEL_RE = /^BR[nzp]*\s+(\S+)$/i;
const PC_LOAD_LABEL_RE = /^(?:LDI|LD|LEA|STI|ST)\s+R[0-7]\s*,\s*(\S+)$/i;
const JSR_LABEL_RE = /^JSR\s+(\S+)$/i;

interface PcRelativeSpan {
  label: string;
  bits: 9 | 11;
  isJsr: boolean;
}

function pcRelativeSpan(t: string): PcRelativeSpan | null {
  let m = BRANCH_LABEL_RE.exec(t);
  if (m) return { label: m[1], bits: 9, isJsr: false };
  m = PC_LOAD_LABEL_RE.exec(t);
  if (m) return { label: m[1], bits: 9, isJsr: false };
  m = JSR_LABEL_RE.exec(t);
  if (m) return { label: m[1], bits: 11, isJsr: true };
  return null;
}

// Recovers the C source line to anchor a reach diagnostic at, from the
// lineMap: the NARROWEST entry that carries a real C line and covers this
// emitted asm line (the most specific statement that produced the
// instruction). Falls back to the enclosing function's declaration — then
// main, then line 1 — when no C-line entry covers the instruction (crt0 /
// runtime code). Degrading to the function rather than guessing means a
// diagnostic never points a student at the wrong C line.
function attributeCSource(
  lineMap: readonly CLineMapEntry[],
  asmLineNo: number,
  currentFunc: string | null,
  funcDeclByName: Map<string, FuncDecl>,
  mainLabel: string,
): { line: number; col: number } {
  let bestLine: number | null = null;
  let bestWidth = Infinity;
  for (const en of lineMap) {
    if (en.cLine === null) continue;
    if (asmLineNo < en.asmStart || asmLineNo > en.asmEnd) continue;
    const width = en.asmEnd - en.asmStart;
    if (width < bestWidth) {
      bestWidth = width;
      bestLine = en.cLine;
    }
  }
  if (bestLine !== null) return { line: bestLine, col: 1 };
  // funcDeclByName is keyed by the mangled label base — the same string
  // `currentFunc` and `mainLabel` carry (both derive from emitted F_<base>
  // labels), so these lookups resolve for case-collision programs too.
  const decl = currentFunc ? funcDeclByName.get(currentFunc) : undefined;
  return decl ?? funcDeclByName.get(mainLabel) ?? { line: 1, col: 1 };
}

// Six ~240-word functions with `main` emitted last, or a single function with
// a loop body / literal pool past the ~255-word branch reach, can put a
// branch/load/call target out of range with no diagnostic until the assembler
// rejects it ("label too far away"). Runs once, after every function, the
// runtime, crt0, and the data sections are fully laid out in `prog.buf`, so
// every label's final address is known.
function checkPcRelativeReach(
  prog: ProgCtx,
  funcDeclByName: Map<string, FuncDecl>,
  mainLabel: string,
): void {
  const lines = prog.buf.lines;
  const addrs = labelAddresses(lines);
  const lineMap = prog.buf.entries;
  // One oversized function can put many spans out of range at once (every
  // literal-pool LD, both of a loop's branches). They all share one root
  // cause — that construct is too large — so report at most once per anchored
  // C line rather than flooding the student with a dozen identical errors.
  const reported = new Set<string>();
  let addr = 0;
  let currentFunc: string | null = null; // null = inside crt0, before any F_<name> label
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!/\s/.test(t) && t.startsWith('F_')) currentFunc = t.slice(2);

    const span = pcRelativeSpan(t);
    // A resolved label target; a numeric #n offset (or anything not in the
    // label map) is already fixed and needs no relocation check.
    const targetAddr = span ? addrs.get(span.label) : undefined;
    if (span && targetAddr !== undefined) {
      const offset = targetAddr - (addr + 1); // PC after fetch is addr+1 (assembler.ts)
      if (!pcOffsetFits(offset, span.bits)) {
        const min = -(1 << (span.bits - 1));
        const max = (1 << (span.bits - 1)) - 1;
        const anchor = attributeCSource(lineMap, i + 1, currentFunc, funcDeclByName, mainLabel);
        const key = `${anchor.line}:${anchor.col}`;
        if (!reported.has(key)) {
          reported.add(key);
          if (span.isJsr) {
            const targetName = span.label.startsWith('F_') ? span.label.slice(2) : span.label;
            const fromName = currentFunc ?? 'crt0';
            prog.diagnostics.push(
              capacityErr(
                anchor,
                `program too large for the LC-3 call range — '${fromName}' cannot reach '${targetName}': the call is ${offset} words away, but an 11-bit PC-relative offset only reaches ${min} to ${max}`,
              ),
            );
          } else {
            prog.diagnostics.push(
              capacityErr(
                anchor,
                `this code is too far from its target for a single LC-3 branch/load — the offset is ${offset} words, but a 9-bit PC-relative offset only reaches ${min} to ${max}. The function or loop body is too large.`,
              ),
            );
          }
        }
      }
    }
    addr += lineWordCount(lines[i]);
  }
}

// =========================================================================
// Program-level image/stack partition guard. The emitted
// image is one contiguous .ORIG x3000 block that grows UP; the runtime stack
// grows DOWN from xF000 (crt0's CRT0_STACK, first push lands at xEFFF).
// Nothing at assemble time knows the stack will reach into a large image at
// run time — so, like checkPcRelativeReach, this guard can only run once the
// whole program is laid out. It rejects any program whose image would reach
// into the region reserved for the stack, which main's prologue pushes would
// otherwise silently overwrite. This is an image-SIZE
// guard, deliberately separate from the PC-relative offset reach pass above
// (BR/load/JSR reach). The next constants define the complete
// memory map.
// IMAGE_ORIGIN is the first generated word address for a runnable program.
// STACK_BASE is the initial empty-stack pointer used by the calling convention.
// STACK_RESERVE keeps a fixed region available below that base for frames.
// The guard rejects any image whose first free address crosses into that region.
// =========================================================================

const IMAGE_ORIGIN = 0x3000; // .ORIG x3000 — the image's base address
const STACK_BASE = 0xf000; // CRT0_STACK — the runtime stack grows DOWN from here
// Words kept free between the top of the image and the stack base: roughly a
// few hundred stack frames of locals + linkage. This partition is tunable
// with this one-line constant.
const STACK_RESERVE = 0x1000;
const IMAGE_LIMIT = STACK_BASE - STACK_RESERVE; // 0xE000 — image may not reach this address
const IMAGE_END_LABEL = 'IMAGE_END';

// Running per-line address map for the whole laid-out image: `addresses[i]`
// is the address the assembler binds to `lines[i]` (IMAGE_ORIGIN plus the
// assembled word count of every prior line, via lineWordCount — the same word
// model checkPcRelativeReach uses). `imageEnd` is the first free
// address above the image (IMAGE_ORIGIN + total image words). Produced once
// and consumed by checkImageFits below; exported (returning the full per-line
// array, not just the total) so the PC-relative relocation pass can reuse
// exactly this layout rather than re-deriving addresses independently.
export function imageLayout(lines: readonly string[]): {
  addresses: number[];
  imageEnd: number;
} {
  const addresses: number[] = [];
  let addr = IMAGE_ORIGIN;
  for (const line of lines) {
    addresses.push(addr);
    addr += lineWordCount(line);
  }
  return { addresses, imageEnd: addr };
}

function toHex4(value: number): string {
  return 'x' + value.toString(16).toUpperCase().padStart(4, '0');
}

// Runs once, after the whole image (crt0 + functions + runtime + globals +
// strings) is laid out — only for a real runnable program, where crt0's
// `.ORIG x3000` and the xF000 stack base actually exist. Anchors its
// student-readable diagnostic at main's declaration (matching how
// checkPcRelativeReach anchors) and names both the actual size and the address
// the image reaches, so the message is actionable rather than a raw error.
function checkImageFits(
  prog: ProgCtx,
  funcDeclByName: Map<string, FuncDecl>,
  mainLabel: string,
): void {
  const { imageEnd } = imageLayout(prog.buf.lines);
  if (imageEnd <= IMAGE_LIMIT) return;
  const words = imageEnd - IMAGE_ORIGIN;
  const anchor = funcDeclByName.get(mainLabel) ?? { line: 1, col: 1 };
  prog.diagnostics.push(
    capacityErr(
      anchor,
      `This program is too large: its code and data need ${words} words and would reach ${toHex4(imageEnd)}, overrunning the memory reserved for the runtime stack (which grows down from xF000). Reduce the program's size.`,
    ),
  );
}

// =========================================================================
// User-name -> assembler-label mangling for a case-insensitive symbol table.
// =========================================================================
//
// Allocation considers user functions and callable runtime labels together.
// Every accepted base is unique after case folding before any prefix is applied.
// Runtime dependency closure reserves only helpers the current program can call.
// One resulting map drives definitions, call targets, pools, and internal labels.
// Collect C-callable runtime names before user-label allocation. The later
// assembly scan remains the authority for what actually splices; this prepass
// exists only so a live runtime F_<name> cannot collide case-insensitively
// with a distinct C function such as Malloc. Walking TypeSpec dimensions too
// keeps this exhaustive over the whole public checked AST, even though calls
// in those constant-only positions cannot reach successful codegen today.
function runtimeLabelBasesForProgram(program: Program): Set<string> {
  const direct = new Set<string>();

  const visitTypeSpec = (spec: TypeSpec): void => {
    for (const dim of spec.dims) {
      if (dim !== null) visitExpr(dim);
    }
  };

  const visitExpr = (expr: Expr): void => {
    switch (expr.kind) {
      case 'IntLit':
      case 'StrLit':
      case 'Ident':
        return;
      case 'SizeofType':
        visitTypeSpec(expr.spec);
        return;
      case 'Cast':
        visitTypeSpec(expr.spec);
        visitExpr(expr.expr);
        return;
      case 'Unary':
      case 'Deref':
      case 'AddrOf':
        visitExpr(expr.expr);
        return;
      case 'Binary':
        visitExpr(expr.left);
        visitExpr(expr.right);
        return;
      case 'Assign':
        visitExpr(expr.target);
        visitExpr(expr.value);
        return;
      case 'Call':
        if (RUNTIME_SECTIONS.has(expr.callee)) direct.add(expr.callee);
        for (const arg of expr.args) visitExpr(arg);
        return;
      case 'Cond':
        visitExpr(expr.cond);
        visitExpr(expr.then);
        visitExpr(expr.else);
        return;
      case 'Subscript':
        visitExpr(expr.array);
        visitExpr(expr.index);
        return;
      case 'Member':
        visitExpr(expr.object);
        return;
      default: {
        const exhaustive: never = expr;
        return exhaustive;
      }
    }
  };

  const visitVarDecl = (decl: VarDecl): void => {
    visitTypeSpec(decl.typeSpec);
    if (decl.init !== undefined) visitExpr(decl.init);
  };

  const visitStmt = (stmt: Stmt): void => {
    switch (stmt.kind) {
      case 'Block':
        for (const child of stmt.stmts) visitStmt(child);
        return;
      case 'VarDecl':
        visitVarDecl(stmt);
        return;
      case 'ExprStmt':
        if (stmt.expr !== null) visitExpr(stmt.expr);
        return;
      case 'If':
        visitExpr(stmt.cond);
        visitStmt(stmt.then);
        if (stmt.else !== null) visitStmt(stmt.else);
        return;
      case 'While':
      case 'DoWhile':
        visitExpr(stmt.cond);
        visitStmt(stmt.body);
        return;
      case 'For':
        if (Array.isArray(stmt.init)) {
          for (const decl of stmt.init) visitVarDecl(decl);
        } else if (stmt.init !== null) {
          visitExpr(stmt.init);
        }
        if (stmt.cond !== null) visitExpr(stmt.cond);
        if (stmt.update !== null) visitExpr(stmt.update);
        visitStmt(stmt.body);
        return;
      case 'Switch':
        visitExpr(stmt.expr);
        for (const row of stmt.cases) {
          if (row.value !== null) visitExpr(row.value);
          for (const child of row.stmts) visitStmt(child);
        }
        return;
      case 'Return':
        if (stmt.expr !== undefined) visitExpr(stmt.expr);
        return;
      case 'Break':
      case 'Continue':
        return;
      default: {
        const exhaustive: never = stmt;
        return exhaustive;
      }
    }
  };

  for (const decl of program.decls) {
    switch (decl.kind) {
      case 'VarDecl':
        visitVarDecl(decl);
        break;
      case 'FuncDecl':
        visitTypeSpec(decl.returnSpec);
        for (const param of decl.params) visitTypeSpec(param.typeSpec);
        if (decl.body !== undefined) visitStmt(decl.body);
        break;
      case 'StructDecl':
        for (const member of decl.members) visitTypeSpec(member.typeSpec);
        break;
      case 'TypedefDecl':
        visitTypeSpec(decl.typeSpec);
        break;
      default: {
        const exhaustive: never = decl;
        return exhaustive;
      }
    }
  }

  const closure = transitiveRuntimeNames(direct, RUNTIME_SECTIONS);
  return new Set([...closure].filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)));
}

// The assembler symbol table is case-insensitive, while C identifiers are
// case-sensitive. Function labels include the source name in F_, L_, and C_
// forms, so raw spellings such as `foo` and `Foo` would collide after folding.
// buildFuncLabels maps each exact C spelling to an assembler-label base
// that stays distinct under case-insensitive comparison. All generated
// prefixes share that base, keeping calls, pools, and internal branches aligned.
//
// A name whose lowercased form is unique among functions and reserved runtime
// bases keeps its exact spelling, preserving readable assembly in the common case.
// Only actual collision groups receive disambiguation. The first available
// spelling in a group remains unchanged; each later member takes the lowest
// free `_cN` suffix. Every suffix is checked case-insensitively against all
// claimed bases, including explicit user names such as `foo_c1`,
// so the final set cannot collide. `main` is ordered first within its group,
// which keeps crt0's entry target readable as `F_main`. Reserved runtime
// label bases participate in the same used-name set. For the same program,
// source order and deterministic suffix selection always produce the same
// labels. The assembler's global case policy remains unchanged.
function buildFuncLabels(
  funcNames: readonly string[],
  reservedRuntimeBases: ReadonlySet<string>,
): Map<string, string> {
  const labels = new Map<string, string>();
  const usedLower = new Set([...reservedRuntimeBases].map((name) => name.toLowerCase()));

  const lowerCounts = new Map<string, number>();
  for (const name of funcNames) {
    const lower = name.toLowerCase();
    lowerCounts.set(lower, (lowerCounts.get(lower) ?? 0) + 1);
  }

  // First, every uniquely lowercased name that is not already reserved keeps
  // its spelling regardless of source order.
  for (const name of funcNames) {
    if (lowerCounts.get(name.toLowerCase()) === 1 && !usedLower.has(name.toLowerCase())) {
      labels.set(name, name);
      usedLower.add(name.toLowerCase());
    }
  }

  // Then resolve collision groups. `main` comes first so the entry point keeps
  // its readable spelling; all other names retain source order. The first free
  // spelling in each group survives, and later members take the lowest free
  // `_cN` suffix. Stable sorting preserves non-main order.
  const ordered = [...funcNames].sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : 0));
  for (const name of ordered) {
    if (labels.has(name)) continue;
    const lower = name.toLowerCase();
    if (!usedLower.has(lower)) {
      labels.set(name, name);
      usedLower.add(lower);
      continue;
    }
    let k = 1;
    let candidate = `${name}_c${k}`;
    while (usedLower.has(candidate.toLowerCase())) {
      k += 1;
      candidate = `${name}_c${k}`;
    }
    labels.set(name, candidate);
    usedLower.add(candidate.toLowerCase());
  }

  return labels;
}

// =========================================================================
// Entry point.
// =========================================================================

export function codegen(program: Program, symbols: SymbolTables, source: string): CodegenResult {
  const reservedRuntimeBases = runtimeLabelBasesForProgram(program);
  const funcLabels = buildFuncLabels([...symbols.functions.keys()], reservedRuntimeBases);
  const mainLabel = funcLabels.get('main') ?? 'main';
  const prog: ProgCtx = {
    buf: new LineBuffer(),
    diagnostics: [],
    funcFrames: symbols.functions,
    funcLabels,
    emittedUserLabelBases: new Set(),
    usedOpSections: new Set(),
    stringCounter: 0,
    strings: [],
    sourceLines: source.split(/\r\n|\r|\n/),
  };

  // crt0 is generated only when the program defines `main` with a body.
  // Synthetic single-function fragments have no main and remain bare assembly
  // without .ORIG/.END. A full program with main receives the complete crt0
  // bootstrap, global base, stack base, and one self-contained .ORIG x3000 to
  // .END image. This distinction preserves fragment use while making runnable
  // programs directly assemblable.
  const hasMain = symbols.functions.has('main');

  // A runaway emission trips LineBuffer's MAX_EMITTED_LINES
  // backstop, which throws. Turn it into a named capacity diagnostic here
  // rather than letting it escape as an unexpected exception.
  try {
    if (hasMain) emitCrt0(prog);

    // Functions emit first so string literals discovered during their
    // bodies are known before the data section is written. funcDeclByName
    // also anchors the JSR-reach guard's diagnostics at the calling
    // function's own declaration — keyed by the MANGLED label base, since the
    // reach pass recovers the current function from the emitted F_<base> label.
    const funcDeclByName = new Map<string, FuncDecl>();
    for (const decl of program.decls) {
      if (decl.kind === 'FuncDecl' && decl.body) {
        const frame = symbols.functions.get(decl.name);
        if (!frame) continue;
        emitFunction(decl, frame, prog);
        funcDeclByName.set(funcLabels.get(decl.name) ?? decl.name, decl);
      }
    }

    const heapRuntimeSpliced = emitRuntimeIfNeeded(prog);

    emitGlobalsSection(program, symbols, prog, hasMain);
    emitStringSection(prog);

    if (heapRuntimeSpliced) {
      // The assembler does not bind a final bare label before .END and rejects a
      // zero-length .BLKW. This sacrificial word is therefore the concrete
      // IMAGE_END label. RTHP_BASE points at the word itself, and first-time
      // allocator initialization deliberately reclaims/overwrites its zero.
      const start = prog.buf.nextLineNo;
      prog.buf.add(`${IMAGE_END_LABEL} .FILL #0`);
      prog.buf.entry(null, 'data', start, prog.buf.lastLineNo);
    }

    if (hasMain) prog.buf.add('.END');

    checkPcRelativeReach(prog, funcDeclByName, mainLabel);
    // The image/stack partition guard applies only when `main` gives crt0 its
    // `.ORIG x3000` wrapper and the xF000 stack it must not collide with; a
    // no-main fragment has neither, so the partition does not apply to it.
    if (hasMain) checkImageFits(prog, funcDeclByName, mainLabel);
  } catch (e) {
    if (!(e instanceof EmittedLinesExceededError)) throw e;
    prog.diagnostics.push(
      capacityErr(
        { line: 1, col: 1 },
        `generated assembly exceeded the ${MAX_EMITTED_LINES}-line limit — this program is too large to compile`,
      ),
    );
    return { asm: '', lineMap: [], diagnostics: prog.diagnostics };
  }

  return {
    asm: prog.buf.lines.join('\n'),
    lineMap: prog.buf.entries,
    diagnostics: prog.diagnostics,
  };
}

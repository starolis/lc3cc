// The public compiler pipeline: lex -> parse -> check -> codegen,
// wired into one entry point, `compileC`.
//
// COMPOSITION CONTRACT for callers that map C source to machine addresses:
// `CcResult.lineMap` maps a C source line to a range of ASM SOURCE LINES
// (1-based, into `CcResult.asm` — the exact numbering codegen.ts's
// `CLineMapEntry` already uses). It does NOT know about memory addresses.
// To go from a C line all the way to an address, a caller composes this
// lineMap with the ASSEMBLER's own lineMap (`AssembleSuccess.lineMap`,
// address -> asm source line, from the assembler API), inverted:
//
//   C line --(this file's lineMap)--> [asmStart, asmEnd] (asm source lines)
//         --(assembler's lineMap, inverted)--> [address range]
//
// Two independent, differently-scoped line-numbering spaces, chained by
// line number. This file produces only the first half; the caller performs the
// second half and the composition.
//
// GATING: codegen assumes its
// input already passed check() clean — foldCaseLabel and other codegen
// internals throw on constructs check() should have rejected (e.g. a case
// label that isn't a constant expression). So codegen is only ever called
// when lex+parse+check produced ZERO 'error' diagnostics. When any of the
// three errored, compileC returns immediately: `ok: false`, `asm: ''`,
// `lineMap: []`, and every diagnostic accumulated so far — codegen never
// runs, and its own diagnostics (capacity guards etc.) never enter the
// result. Diagnostics accumulate across stages in a fixed order: lex,
// parse, check, then (only when reached) codegen. `ok` is true only when
// NO stage — including codegen — produced an 'error' diagnostic; warnings
// never affect `ok`.
//
// This same "no errors anywhere" invariant also governs `asm`/`lineMap`
// after codegen runs: codegen can itself add capacity-guard errors (too
// many locals, a literal pool out of PCoffset9 reach, ...) even though the
// input was check-clean. When that happens the partial `asm` codegen did
// manage to emit may be missing whole functions (emitFunction bails out
// before emitting anything for an over-capacity function) or reference
// labels that were never emitted — not safe to hand a caller. So the same
// rule applies uniformly: `ok === false` always implies `asm === ''` and
// `lineMap === []`, regardless of which stage supplied the error.
//
// NO-MAIN POLICY: a program that compiles clean but
// never defines `main` produces a non-runnable fragment — codegen already
// knows this and skips crt0 (no .ORIG/.END wrapper) whenever `main` is
// absent, emitting just the compiled functions/data as a bare fragment.
// That's a legitimate thing to want (a professor compiling a fragment to
// read the generated assembly, or an editor compiling source before it has a
// main), so this is a WARNING, not an error: `ok` stays true, `asm` is
// still the real fragment.
//
// SYMBOLS: `symbols` reflects whatever check() produced, and is returned
// even when `ok` is false (the UI may still want frame offsets/types for a
// program that fails later). check() runs unconditionally in this pipeline
// (it never throws — every diagnostic it finds is pushed, not thrown — and
// it tolerates a parser-recovered, partially-built AST), so in practice
// `symbols` is always the real result. The contract's degenerate case (an
// empty `{ globals: [], functions: new Map() }` for when check did not run
// at all) has no live code path today because check() always runs here;
// it is documented for a future pipeline shape where that could change.
//
// CHECKED PROGRAM: a successful result also exposes the exact Program instance
// that passed check() and codegen(). check() stamps semantic facts directly on
// that tree (resolved symbols/types), so returning it avoids a second parse or
// check pass for teaching surfaces that need the operation the source expressed.
// A failed result always carries null: a parser-recovered tree or one whose
// codegen later failed is not a successful checked-program artifact.

import type { Program } from './ast.js';
import { check } from './check.js';
import { codegen, type CLineMapEntry } from './codegen.js';
import type { CcDiagnostic } from './diagnostics.js';
import { lex } from './lexer.js';
import { parse } from './parser.js';
import type { SymbolTables } from './symbols.js';

export interface CcResult {
  ok: boolean;
  asm: string;
  diagnostics: CcDiagnostic[];
  lineMap: CLineMapEntry[];
  symbols: SymbolTables;
  program: Program | null;
  // Which artifact `asm` is, made explicit so `ok: true` alone
  // never falsely implies a runnable program. 'program' — a complete program:
  // `main` is defined, so codegen wrapped `asm` in the .ORIG/.END crt0 (see
  // NO-MAIN POLICY below); it is assemblable and runnable. 'fragment' —
  // compiled clean but with no `main`, so codegen emitted a bare fragment with
  // NO .ORIG/.END wrapper; a legitimate thing to want (reading generated
  // assembly), but not assemblable on its own and not runnable. 'none' — the
  // compile failed (`ok: false`); `asm` is '' and there is no artifact.
  artifact: 'program' | 'fragment' | 'none';
}

function hasError(diagnostics: CcDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

function noMainWarning(): CcDiagnostic {
  return {
    line: 1,
    col: 1,
    message: 'no main function — the program will compile but cannot run',
    severity: 'warning',
  };
}

const EMPTY_SYMBOLS: SymbolTables = { globals: [], functions: new Map() };

// The pipeline applies explicit budgets to known pathologies: macro tokens,
// expression depth, statement depth, and emitted lines each produce a named,
// located diagnostic instead of exhausting host resources. The outer
// try/catch is a backstop for unexpected exceptions: it degrades any failure
// to `ok: false` with a located compiler diagnostic instead of exposing a
// raw throw to the caller.
export function compileC(source: string): CcResult {
  try {
    return runPipeline(source.replace(/\r\n?/g, '\n'));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      asm: '',
      diagnostics: [
        {
          line: 1,
          col: 1,
          message: `internal compiler error: ${message} — please report this program`,
          severity: 'error',
        },
      ],
      lineMap: [],
      symbols: EMPTY_SYMBOLS,
      program: null,
      artifact: 'none',
    };
  }
}

function runPipeline(source: string): CcResult {
  const diagnostics: CcDiagnostic[] = [];

  const { tokens, diagnostics: lexDiags } = lex(source);
  diagnostics.push(...lexDiags);

  const { program, diagnostics: parseDiags } = parse(tokens);
  diagnostics.push(...parseDiags);

  const { symbols, diagnostics: checkDiags } = check(program);
  diagnostics.push(...checkDiags);

  if (hasError(diagnostics)) {
    return {
      ok: false,
      asm: '',
      diagnostics,
      lineMap: [],
      symbols,
      program: null,
      artifact: 'none',
    };
  }

  const hasMain = symbols.functions.has('main');
  if (!hasMain) {
    diagnostics.push(noMainWarning());
  }

  const { asm, lineMap, diagnostics: codegenDiags } = codegen(program, symbols, source);
  diagnostics.push(...codegenDiags);

  if (hasError(diagnostics)) {
    return {
      ok: false,
      asm: '',
      diagnostics,
      lineMap: [],
      symbols,
      program: null,
      artifact: 'none',
    };
  }

  // Only a program with `main` carries the .ORIG/.END crt0 wrapper (NO-MAIN
  // POLICY above), so only it is assemblable and runnable; a no-main compile is
  // a non-runnable fragment.
  const artifact = hasMain ? 'program' : 'fragment';
  return { ok: true, asm, diagnostics, lineMap, symbols, program, artifact };
}

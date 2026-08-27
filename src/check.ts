// Semantic checker for the documented C subset.
// Consumes the parsed AST, produces frame-offset symbol tables, and emits
// diagnostics in the same student-facing voice as the
// lexer/parser.
//
// Float/double are rejected by the parser. Struct and typedef syntax is resolved
// syntax channel through checker-owned tag and alias tables: one interned
// StructType per tag, completed in place, plus a definition-index table that
// preserves completeness at each source position across the two passes.
// Pointers and arrays use distinct semantic types: a declarator
// (VarDecl.typeSpec, Param.typeSpec,
// FuncDecl.returnSpec)
// resolves to a real CType here (via resolveTypeSpec below), stamped
// onto resolvedType/resolvedReturnType so codegen never re-folds a dimension
// expression. Pointer/array EXPRESSIONS (Subscript, Deref, AddrOf) are real,
// typed expressions too (via isLvalue/checkAddrOf/checkDeref/
// checkSubscript/checkPointerBinary below). Value forms are accepted
// throughout semantic checking. Lvalue contexts remain stricter:
// `&expr` is never a writable location in C, so using AddrOf as
// an assignment target or an
// lvalue read-write operand (`&x = 5`, `(&x)++`) keeps the same permanent
// "must be a variable" message every other non-lvalue target gets — see the
// comment on checkAssign's and checkLvalueReadWrite's isLvalue guards for why
// that is a permanent language rule rather than an omitted capability.
// Diagnostics describe current behavior without implementation chronology.
// "Floating point" surfaces as a checker-owned rejection at exactly two sites:
// printf's and scanf's %f conversions below, since format
// strings are plain string data the parser has no reason to inspect — both
// route through features.ts's shared FLOAT_CONVERSION rather than each
// hand-writing the same sentence, so this stays two call sites of one
// message, not two messages. Codegen emits a Subscript/Member/Deref/AddrOf through
// emitAddress; this file only types them.

import type {
  AddrOf,
  ArrayType,
  Assign,
  Binary,
  Block,
  Cast,
  CType,
  Call,
  Cond,
  Deref,
  Expr,
  For,
  FuncDecl,
  Ident,
  If,
  Member,
  Program,
  Return,
  SizeofType,
  Stmt,
  StrLit,
  StructDecl,
  StructMember,
  StructType,
  Subscript,
  Switch,
  SwitchCase,
  TypeSpec,
  TypedefDecl,
  Unary,
  VarDecl,
} from './ast.js';
import {
  arr,
  decay,
  isArray,
  isPointer,
  isScalar,
  isStruct,
  pointeeOf,
  ptr,
  sizeInWords,
  typeName,
  typesEqual,
} from './ast.js';
import type { CcDiagnostic } from './diagnostics.js';
import {
  CAST_BEYOND_MALLOC_RESULT,
  FLOAT_CONVERSION,
  LIBRARY_FUNCTION_FEATURES,
  POINTER_RELATIONAL,
  POINTER_SUBTRACTION,
  SCANF_UNSUPPORTED_CONVERSION,
  STRING_LITERAL_CONTEXT,
  STRUCT_ASSIGNMENT,
  STRUCT_BY_VALUE_ARGUMENT,
  STRUCT_RETURN,
  STRUCT_TYPED_MEMBER,
  UNSPECIFIED_ARRAY_DIMENSION,
  VARIABLE_LENGTH_ARRAY,
  VOID_POINTER_ARITHMETIC,
  VOID_POINTER_TYPE,
} from './features.js';
import { compare16, shiftLeft16, shiftRight16, wrapTo16Signed } from './int16.js';
import { ALWAYS_VISIBLE, Resolver, type Binding, type VarBinding } from './scopes.js';
import { localWordCount } from './symbols.js';
import type { FuncFrame, SymbolTables, VarSymbol } from './symbols.js';

function unexpectedTopLevelDecl(decl: never): never {
  throw new Error(`check: unexpected top-level declaration ${String(decl)}`);
}

interface TypeEnvironment {
  structs: Map<string, StructType>;
  typedefs: Map<string, CType>;
  definitionAt: Map<string, number>;
}

function internStruct(tag: string, types: TypeEnvironment): StructType {
  const existing = types.structs.get(tag);
  if (existing) return existing;
  const created: StructType = {
    kind: 'struct',
    tag,
    members: [],
    sizeWords: 0,
    complete: false,
  };
  types.structs.set(tag, created);
  return created;
}

// The first struct whose size is needed without crossing a pointer. Arrays
// recurse because their storage contains their elements inline; pointers stop
// because the pointed-to object has no storage at the declaration site.
function directStructIn(type: CType): StructType | null {
  if (isScalar(type) || isPointer(type)) return null;
  if (isStruct(type)) return type;
  return directStructIn(type.of);
}

function hasDirectVoidStorage(type: CType): boolean {
  if (isPointer(type) || isStruct(type)) return false;
  if (isScalar(type)) return type === 'void';
  return hasDirectVoidStorage(type.of);
}

// Source code may not preserve the internal void * type used by malloc/free.
// Walk arrays and every pointer layer so aliases or deeper spellings such as
// void ** cannot smuggle a pointer-to-void through the one TypeSpec gateway.
function containsPointerToVoid(type: CType): boolean {
  if (isScalar(type) || isStruct(type)) return false;
  if (isArray(type)) return containsPointerToVoid(type.of);
  return type.to === 'void' || containsPointerToVoid(type.to);
}

// Completeness is temporal. Pass 1 eventually mutates every valid definition's
// interned object to complete, but pass 2 must not let a function body see a
// definition that occurs later in source order.
function incompleteStructAt(
  type: CType,
  declarationIndex: number,
  types: TypeEnvironment,
): StructType | null {
  const direct = directStructIn(type);
  if (!direct) return null;
  const definedAt = types.definitionAt.get(direct.tag);
  return direct.complete && definedAt !== undefined && definedAt <= declarationIndex
    ? null
    : direct;
}

function requireCompleteObject(
  type: CType,
  name: string,
  declarationIndex: number,
  types: TypeEnvironment,
  diagnostics: CcDiagnostic[],
  node: { line: number; col: number },
): boolean {
  const incomplete = incompleteStructAt(type, declarationIndex, types);
  if (!incomplete) return true;
  diagnostics.push(
    err(
      node,
      `'${name}' has incomplete type 'struct ${incomplete.tag}' here — define it before declaring it by value, or declare a pointer instead`,
    ),
  );
  return false;
}

function requireCompletePointerArithmetic(
  pointee: CType,
  node: { line: number; col: number },
  ctx: Ctx,
): boolean {
  if (pointee === 'void') {
    ctx.diagnostics.push(err(node, VOID_POINTER_ARITHMETIC.message));
    return false;
  }
  const incomplete = incompleteStructAt(pointee, ctx.currentDeclIndex, ctx.types);
  if (!incomplete) return true;
  ctx.diagnostics.push(
    err(
      node,
      `pointer arithmetic needs the complete size of 'struct ${incomplete.tag}' — define it before this operation`,
    ),
  );
  return false;
}

// Resolves a declaration or abstract type-name spec into a semantic type
// before later passes consume it. Array dimensions
// fold through the same foldConstExpr every other constant context uses, so
// a #define name works and a `const` identifier gets the existing
// "must be a constant expression" message. Returns null when the spec is
// unusable; the caller has already had a diagnostic pushed.
function resolveTypeSpec(
  spec: TypeSpec,
  diagnostics: CcDiagnostic[],
  node: { line: number; col: number },
  isParam: boolean,
  types: TypeEnvironment,
  declarationIndex: number,
): CType | null {
  // Stamp the whole dimension forest before resolving or folding any one
  // dimension. A failure in one dimension must not hide a second sizeof in
  // another, and a malformed surrounding type must not leave these public
  // nodes at the unchecked `undefined` state.
  let sizeofValid = true;
  for (const dim of spec.dims) {
    if (dim !== null && !stampSizeofTypes(dim, diagnostics, types, declarationIndex)) {
      sizeofValid = false;
    }
  }
  if (!sizeofValid) return null;

  let type: CType;
  if (typeof spec.base === 'string') {
    type = spec.base;
  } else if ('struct' in spec.base) {
    type = internStruct(spec.base.struct, types);
  } else {
    const resolved = types.typedefs.get(spec.base.typedefName);
    if (!resolved) {
      diagnostics.push(
        err(node, `typedef '${spec.base.typedefName}' does not name a resolved type here`),
      );
      return null;
    }
    type = resolved;
  }
  for (let i = 0; i < spec.pointerDepth; i++) type = ptr(type);

  // Dimensions apply right to left: `int a[3][4]` is an array of 3 rows of
  // 4, so the innermost (rightmost) dimension is built first.
  for (let i = spec.dims.length - 1; i >= 0; i--) {
    const dim = spec.dims[i];
    if (dim === null) {
      // Only the leading dimension of a parameter, and only there because
      // the whole array type is about to decay to a pointer anyway.
      if (!isParam || i !== 0) {
        diagnostics.push(err(node, UNSPECIFIED_ARRAY_DIMENSION.message));
        return null;
      }
      type = ptr(type);
      continue;
    }
    // After the eager sizeof prewalk above, foldConstExpr pushes its own
    // diagnostic on every remaining failure (a `const` identifier and a
    // genuine runtime variable are indistinguishable to it — it has no case
    // for 'Ident' at all), but that diagnostic is never the one a student
    // should see here: the diagnostic policy is one report per mistake,
    // and the VLA message below is the more useful, more specific one (it
    // names the remedy). Fold into a scratch sink so a failure's diagnostic is
    // replaced, not duplicated. Success does not guarantee the sink is empty,
    // though: a short-circuited &&/|| arm
    // still recurses (with suppressValueError) for its STATIC errors alone,
    // and the StrLit case pushes unconditionally, so a fold can succeed
    // (return non-null) while having pushed — the push below is
    // unconditional for exactly that reason, not only for the failure path.
    const scratch: CcDiagnostic[] = [];
    const length = foldConstExpr(dim, scratch, 'an array size');
    if (length === null) {
      diagnostics.push(err(dim, VARIABLE_LENGTH_ARRAY.message));
      return null;
    }
    diagnostics.push(...scratch);
    if (length <= 0) {
      diagnostics.push(err(dim, `an array size must be greater than zero (got ${length})`));
      // Keep the declaration registered after the one useful diagnostic. A
      // one-element placeholder preserves the written array shape for later uses
      // (including subscripts) while compileC's error gate guarantees this
      // recovery type can never reach codegen.
      type = arr(type, 1);
      continue;
    }
    type = arr(type, length);
  }

  if (containsPointerToVoid(type)) {
    diagnostics.push(err(node, VOID_POINTER_TYPE.message));
    return null;
  }

  // C's array-to-pointer adjustment for parameters (book 16.3.3): the
  // parameter receives the base address, never a copy. Applied AFTER the
  // dimensions are built, so `int image[3][4]` becomes pointer-to-int[4] and
  // pointer arithmetic on it scales by the row length.
  return isParam ? decay(type) : type;
}

const SIZEOF_VOID =
  "'sizeof' cannot measure 'void' object storage — use a complete object type or a pointer type";
const MAX_SIZEOF_BYTES = 0x7fff;

function resolveSizeofType(
  expr: SizeofType,
  diagnostics: CcDiagnostic[],
  types: TypeEnvironment,
  declarationIndex: number,
): boolean {
  expr.resolvedValue = null;
  const type = resolveTypeSpec(expr.spec, diagnostics, expr, false, types, declarationIndex);
  if (type === null) return false;
  if (hasDirectVoidStorage(type)) {
    diagnostics.push(err(expr, SIZEOF_VOID));
    return false;
  }
  const incomplete = incompleteStructAt(type, declarationIndex, types);
  if (incomplete) {
    diagnostics.push(
      err(
        expr,
        `'sizeof' needs the complete definition of 'struct ${incomplete.tag}' — define it before this use`,
      ),
    );
    return false;
  }
  const byteCount = 2 * sizeInWords(type);
  if (!Number.isSafeInteger(byteCount) || byteCount > MAX_SIZEOF_BYTES) {
    diagnostics.push(
      err(
        expr,
        `'sizeof' result ${byteCount} cannot be represented by this C subset's positive 16-bit byte count (${MAX_SIZEOF_BYTES} maximum)`,
      ),
    );
    return false;
  }
  expr.resolvedValue = wrapTo16Signed(byteCount);
  return true;
}

// Prewalk for the three expression positions that fold without going through
// checkExpr: declarator dimensions, global initializers, and case labels.
// This is intentionally eager and exhaustive: static type errors in an
// untaken &&/||/?: branch are still errors, matching foldConstExpr's existing
// constant-expression policy.
function stampSizeofTypes(
  expr: Expr,
  diagnostics: CcDiagnostic[],
  types: TypeEnvironment,
  declarationIndex: number,
): boolean {
  switch (expr.kind) {
    case 'SizeofType':
      return resolveSizeofType(expr, diagnostics, types, declarationIndex);
    case 'Unary':
    case 'Deref':
    case 'AddrOf':
      return stampSizeofTypes(expr.expr, diagnostics, types, declarationIndex);
    case 'Cast': {
      // The source void * wall applies to every TypeSpec, including a cast in
      // one of these fold-only positions. Resolve only the target syntax here;
      // the ordinary Cast shape remains checkExpr's responsibility.
      const target = resolveTypeSpec(expr.spec, diagnostics, expr, false, types, declarationIndex);
      if (target === null) return false;
      return stampSizeofTypes(expr.expr, diagnostics, types, declarationIndex);
    }
    case 'Binary': {
      const left = stampSizeofTypes(expr.left, diagnostics, types, declarationIndex);
      const right = stampSizeofTypes(expr.right, diagnostics, types, declarationIndex);
      return left && right;
    }
    case 'Assign': {
      const target = stampSizeofTypes(expr.target, diagnostics, types, declarationIndex);
      const value = stampSizeofTypes(expr.value, diagnostics, types, declarationIndex);
      return target && value;
    }
    case 'Call': {
      let valid = true;
      for (const arg of expr.args) {
        if (!stampSizeofTypes(arg, diagnostics, types, declarationIndex)) valid = false;
      }
      return valid;
    }
    case 'Cond': {
      const cond = stampSizeofTypes(expr.cond, diagnostics, types, declarationIndex);
      const then = stampSizeofTypes(expr.then, diagnostics, types, declarationIndex);
      const otherwise = stampSizeofTypes(expr.else, diagnostics, types, declarationIndex);
      return cond && then && otherwise;
    }
    case 'Subscript': {
      const array = stampSizeofTypes(expr.array, diagnostics, types, declarationIndex);
      const index = stampSizeofTypes(expr.index, diagnostics, types, declarationIndex);
      return array && index;
    }
    case 'Member':
      return stampSizeofTypes(expr.object, diagnostics, types, declarationIndex);
    case 'IntLit':
    case 'StrLit':
    case 'Ident':
      return true;
    default: {
      const exhaustive: never = expr;
      return exhaustive;
    }
  }
}

// The lvalue forms, and the ONLY things `&` may be applied to or an
// assignment/lvalue-read-write may target. An array name is an lvalue but is
// not MODIFIABLE (book 16.3.5: an array identifier names a fixed place),
// which checkAssign checks separately, after this returns true for it.
//
// AddrOf is deliberately EXCLUDED: the result of `&` is never an lvalue in C,
// so `&x = 5` and `(&x)++` are exactly as invalid as
// `5 = x` or `(a + b)++`. checkAssign and checkLvalueReadWrite
// both use the ordinary "must be a variable" message for anything
// rejected by isLvalue, including AddrOf. That is the permanent behavior.
// A generic pointer-placeholder diagnostic would falsely promise that
// an AddrOf target becomes valid when pointer expressions are supported,
// even though C never permits assignment to the value produced by `&`.
// Keep AddrOf distinct from Subscript, Member, and Deref in this predicate;
// those three forms can denote storage, while AddrOf produces a pointer value.
// This distinction prevents the non-lvalue regression described above.
function isLvalue(expr: Expr): boolean {
  return (
    expr.kind === 'Ident' ||
    expr.kind === 'Deref' ||
    expr.kind === 'Subscript' ||
    expr.kind === 'Member'
  );
}

// Per-function checking context. Ordinary-identifier scoping lives in the
// shared Resolver (scopes.ts); this only carries the function-local
// bookkeeping. `currentDeclIndex` is this function definition's position in
// program.decls, so the resolver can enforce declare-before-use (a file-scope
// name declared later is not visible here). `initializing` is the local whose
// initializer is currently being checked — reading it there is the "read in
// its own initializer" error.
interface Ctx {
  diagnostics: CcDiagnostic[];
  resolver: Resolver;
  types: TypeEnvironment;
  currentDeclIndex: number;
  initializing: VarSymbol | null;
  locals: VarSymbol[];
  nextLocalOffset: number;
  returnType: CType;
  loopDepth: number;
  switchDepth: number;
}

// The frame guard is a WORD count, not a slot count — an array is
// many words. 512 words leaves room for eight frames of maximum size inside
// the 4096-word stack reserve (codegen.ts's STACK_RESERVE), and is the same
// kind of tunable knob: raising it trades run-time stack depth for maximum
// frame size.
const MAX_FRAME_WORDS = 512;

// A variable of k words occupies the k offsets DESCENDING from the cursor,
// and records the offset of its FIRST word, which is its lowest address and
// therefore an array's base. For k === 1 this is exactly the scalar
// `offset = cursor; cursor -= 1`, which is why no scalar offset moves.
function allocateLocal(ctx: Ctx, type: CType): number {
  const words = sizeInWords(type);
  const offset = ctx.nextLocalOffset - (words - 1);
  ctx.nextLocalOffset -= words;
  return offset;
}

function err(node: { line: number; col: number }, message: string): CcDiagnostic {
  return { line: node.line, col: node.col, message, severity: 'error' };
}

function warn(node: { line: number; col: number }, message: string): CcDiagnostic {
  return { line: node.line, col: node.col, message, severity: 'warning' };
}

// A shift's count operand that const-folds outside 0..15 is a compile error
// because C leaves a shift by the operand's width or more (and any
// negative count) undefined; this subset lowers a shift to a counted loop with
// one specific documented behavior, so a folded out-of-range count would give a
// definite wrong answer (e.g. `1 << 32` folds to 0, never what the student
// meant) and, in a divisor position, `7 / (1 << 32)` would otherwise slip past
// the constant-zero-divisor guard. A named error teaches; a quiet wrong answer
// does not.
function isShiftCountInRange(count: number): boolean {
  return count >= 0 && count <= 15;
}

function shiftCountError(node: { line: number; col: number }, count: number): CcDiagnostic {
  return err(
    node,
    `shift count ${count} is outside the LC-3 subset's defined range 0..15 — C leaves shifts by 16 or more (or negative counts) undefined`,
  );
}

// Shared by global initializers and switch case labels, both of which require
// integer constant expressions). Folds literals, checker-stamped sizeof type
// nodes, unary -/~/!, and binary integer ops on constants; identifiers, calls,
// assignments, string literals, and ++/-- are not constant expressions in
// this subset and are reported at the point they're found.
//
// Exported so codegen.ts can re-fold a case label (already validated as a
// constant expression here) and emit it directly via emitConstant, instead
// of emitExpr — a case label evaluated through the general expression
// emitter can clobber R1, which the switch's own value-under-test is
// sitting in at that point (see codegen.ts's emitSwitch).
//
// `suppressValueError` gates ONE diagnostic only: the runtime division-by-zero
// VALUE error. A branch that short-circuit (&&/||) or ternary condition proves
// is never evaluated at runtime is still RECURSED INTO for STATIC validation
// (undeclared/non-constant identifier, string literal, ++/--, any structural
// error all still fire), because in a CONST context this fold is the only
// visitor — nothing else would catch those. Only the value-level div-by-zero,
// which the runtime never reaches on that branch, is suppressed there.
export function foldConstExpr(
  expr: Expr,
  diagnostics: CcDiagnostic[],
  context: string,
  suppressValueError = false,
): number | null {
  switch (expr.kind) {
    case 'IntLit':
      return wrapTo16Signed(expr.value);
    case 'SizeofType':
      return typeof expr.resolvedValue === 'number' ? expr.resolvedValue : null;
    case 'StrLit':
      diagnostics.push(err(expr, STRING_LITERAL_CONTEXT.message));
      return null;
    case 'Unary': {
      if (expr.op === '++' || expr.op === '--') {
        diagnostics.push(err(expr, `${context} must be a constant expression`));
        return null;
      }
      const v = foldConstExpr(expr.expr, diagnostics, context, suppressValueError);
      if (v === null) return null;
      if (expr.op === '-') return wrapTo16Signed(-v);
      if (expr.op === '~') return wrapTo16Signed(~v);
      return v === 0 ? 1 : 0; // '!'
    }
    case 'Binary': {
      // && / || fold LAZILY: a short-circuited right operand is never
      // evaluated at runtime, so its runtime division-by-zero VALUE never
      // rejects the program. But its STATIC errors (undeclared/non-constant
      // identifier, string literal, ++/--) must still fire — this fold is the
      // only visitor in a const context — so we recurse into the skipped
      // branch with suppressValueError=true and discard its returned value,
      // then return the short-circuit result. Only these two operators
      // short-circuit; every other binary operator (including bitwise & / |)
      // folds both sides.
      if (expr.op === '&&' || expr.op === '||') {
        const l = foldConstExpr(expr.left, diagnostics, context, suppressValueError);
        const shortCircuits =
          l !== null && ((expr.op === '&&' && l === 0) || (expr.op === '||' && l !== 0));
        if (shortCircuits) {
          foldConstExpr(expr.right, diagnostics, context, true);
          return expr.op === '&&' ? 0 : 1;
        }
        if (l === null) return null;
        const r = foldConstExpr(expr.right, diagnostics, context, suppressValueError);
        if (r === null) return null;
        return r !== 0 ? 1 : 0;
      }

      const l = foldConstExpr(expr.left, diagnostics, context, suppressValueError);
      const r = foldConstExpr(expr.right, diagnostics, context, suppressValueError);
      if (l === null || r === null) return null;
      if ((expr.op === '/' || expr.op === '%') && r === 0) {
        if (!suppressValueError) {
          diagnostics.push(err(expr, 'division by zero in a constant expression'));
        }
        return null;
      }
      switch (expr.op) {
        case '+':
          return wrapTo16Signed(l + r);
        case '-':
          return wrapTo16Signed(l - r);
        case '*':
          return wrapTo16Signed(l * r);
        case '/':
          return wrapTo16Signed(Math.trunc(l / r));
        case '%':
          return wrapTo16Signed(l % r);
        case '&':
          return wrapTo16Signed(l & r);
        case '|':
          return wrapTo16Signed(l | r);
        case '^':
          return wrapTo16Signed(l ^ r);
        // Shifts fold through the SAME loop the emitted code runs (int16.ts's
        // shiftLeft16 / shiftRight16 mirror codegen's emitShift*Combine), so a
        // folded shift equals its runtime result. A count that
        // folds outside 0..15 is a value-level error, gated like div-by-zero on
        // suppressValueError so a provably-dead &&/||/?: arm never false-reports.
        case '<<':
        case '>>':
          if (!isShiftCountInRange(r)) {
            if (!suppressValueError) {
              diagnostics.push(shiftCountError(expr, r));
            }
            return null;
          }
          return expr.op === '<<' ? shiftLeft16(l, r) : shiftRight16(l, r);
        // Comparisons fold through the SAME sign-split algorithm the emitted
        // code uses (int16.ts's compare16 mirrors codegen's emitCompareCombine),
        // so a folded comparison equals its runtime result and both are
        // mathematically correct on every supported int.
        case '<':
        case '<=':
        case '>':
        case '>=':
        case '==':
        case '!=':
          return compare16(expr.op, l, r);
      }
      return null;
    }
    // ?: folds LAZILY too: fold the condition, then return ONLY the taken
    // branch's value — mirroring emitTernary, which branches over the untaken
    // side, so its runtime division-by-zero never rejects the program. The
    // UNTAKEN arm is still recursed into (suppressValueError=true, value
    // discarded) so its STATIC errors — undeclared/non-constant identifier,
    // string literal, ++/-- — still surface, matching how a function body
    // visits both arms.
    case 'Cond': {
      const c = foldConstExpr(expr.cond, diagnostics, context, suppressValueError);
      if (c === null) return null;
      // Fold both arms in source order (then, then else) so diagnostics stay
      // ordered; suppress div-by-zero on the untaken arm and keep only the
      // taken arm's value.
      const takeThen = c !== 0;
      const thenVal = foldConstExpr(
        expr.then,
        diagnostics,
        context,
        takeThen ? suppressValueError : true,
      );
      const elseVal = foldConstExpr(
        expr.else,
        diagnostics,
        context,
        takeThen ? true : suppressValueError,
      );
      return takeThen ? thenVal : elseVal;
    }
    default:
      diagnostics.push(err(expr, `${context} must be a constant expression`));
      return null;
  }
}

function seedBuiltins(resolver: Resolver): void {
  const builtins: { name: string; returnType: CType; params: CType[]; variadic: boolean }[] = [
    { name: 'putchar', returnType: 'int', params: ['int'], variadic: false },
    { name: 'getchar', returnType: 'int', params: [], variadic: false },
    { name: 'printf', returnType: 'int', params: [ptr('char')], variadic: true },
    { name: 'scanf', returnType: 'int', params: [ptr('char')], variadic: true },
    { name: 'strcmp', returnType: 'int', params: [ptr('char'), ptr('char')], variadic: false },
    {
      name: 'strcpy',
      returnType: ptr('char'),
      params: [ptr('char'), ptr('char')],
      variadic: false,
    },
    { name: 'malloc', returnType: ptr('void'), params: ['int'], variadic: false },
    { name: 'free', returnType: 'void', params: [ptr('void')], variadic: false },
  ];
  for (const b of builtins) {
    resolver.declare(b.name, {
      kind: 'func',
      name: b.name,
      returnType: b.returnType,
      params: b.params,
      variadic: b.variadic,
      isBuiltin: true,
      hasBody: false,
      declaredAt: ALWAYS_VISIBLE,
    });
  }
}

export function check(program: Program): { symbols: SymbolTables; diagnostics: CcDiagnostic[] } {
  const diagnostics: CcDiagnostic[] = [];
  const globals: VarSymbol[] = [];
  const functions = new Map<string, FuncFrame>();
  const resolver = new Resolver();
  const types: TypeEnvironment = {
    structs: new Map(),
    typedefs: new Map(),
    definitionAt: new Map(),
  };
  seedBuiltins(resolver);
  // Globals grow UP from offset 0, so this cursor threads
  // ascending through registerGlobal — a variable of k words simply claims
  // offsets [next, next+k), and element 0 of a global array is its offset.
  const globalCursor = { next: 0 };

  // Pass 1: register every file-scope name in source order, tagging each with
  // its declaration index so pass 2 can enforce declare-before-use (Ch 14
  // section 14.2.1.1 / Appendix D section D.4). Registration first (not
  // interleaved with body checking) keeps every function's whole signature —
  // including a body that appears later — known before any body is checked, so
  // "declared but never defined" and duplicate-definition diagnostics stay
  // whole-program and in source order.
  program.decls.forEach((decl, index) => {
    switch (decl.kind) {
      case 'VarDecl':
        registerGlobal(decl, index, diagnostics, resolver, globals, globalCursor, types);
        break;
      case 'FuncDecl':
        registerFunction(decl, index, diagnostics, resolver, types);
        break;
      case 'StructDecl':
        registerStructDefinition(decl, index, diagnostics, types);
        break;
      case 'TypedefDecl':
        registerTypedef(decl, index, diagnostics, resolver, types);
        break;
      default:
        unexpectedTopLevelDecl(decl);
    }
  });

  // Pass 2: fold global initializers and check function bodies. A body checked
  // at its own decl index sees only file-scope names declared at or before it.
  program.decls.forEach((decl, index) => {
    switch (decl.kind) {
      case 'VarDecl':
        foldGlobalInit(decl, index, diagnostics, resolver, types);
        break;
      case 'FuncDecl':
        if (decl.body) checkFunctionBody(decl, index, diagnostics, resolver, functions, types);
        break;
      case 'StructDecl':
      case 'TypedefDecl':
        break;
      default:
        unexpectedTopLevelDecl(decl);
    }
  });

  return { symbols: { globals, functions }, diagnostics };
}

function registerTypedef(
  decl: TypedefDecl,
  index: number,
  diagnostics: CcDiagnostic[],
  resolver: Resolver,
  types: TypeEnvironment,
): void {
  if (types.typedefs.has(decl.name)) {
    diagnostics.push(err(decl, `typedef '${decl.name}' is already defined`));
    return;
  }
  if (resolver.lookupInCurrentScope(decl.name)) {
    diagnostics.push(err(decl, `'${decl.name}' is already declared in this scope`));
    return;
  }
  const type = resolveTypeSpec(decl.typeSpec, diagnostics, decl, false, types, index);
  if (type !== null) types.typedefs.set(decl.name, type);
}

function registerStructDefinition(
  decl: StructDecl,
  index: number,
  diagnostics: CcDiagnostic[],
  types: TypeEnvironment,
): void {
  const type = internStruct(decl.tag, types);
  if (types.definitionAt.has(decl.tag)) {
    diagnostics.push(err(decl, `struct '${decl.tag}' is already defined`));
    return;
  }

  // The first attempt owns the tag even when a bad member keeps it
  // incomplete. A later definition is therefore a redefinition, not a quiet
  // retry with a different layout.
  types.definitionAt.set(decl.tag, index);
  const members: StructMember[] = [];
  const names = new Set<string>();
  let sizeWords = 0;
  let valid = true;

  for (const memberDecl of decl.members) {
    if (names.has(memberDecl.name)) {
      diagnostics.push(
        err(memberDecl, `struct '${decl.tag}' already has a member named '${memberDecl.name}'`),
      );
      valid = false;
      continue;
    }
    names.add(memberDecl.name);

    const diagnosticsBeforeType = diagnostics.length;
    const memberType = resolveTypeSpec(
      memberDecl.typeSpec,
      diagnostics,
      memberDecl,
      false,
      types,
      index,
    );
    if (memberType === null || diagnostics.length > diagnosticsBeforeType) {
      valid = false;
      continue;
    }
    if (hasDirectVoidStorage(memberType)) {
      diagnostics.push(
        err(
          memberDecl,
          `member '${memberDecl.name}' of struct '${decl.tag}' cannot have void object storage`,
        ),
      );
      valid = false;
      continue;
    }
    const containedStruct = directStructIn(memberType);
    if (containedStruct) {
      const prefix = containedStruct.complete
        ? ''
        : `member '${memberDecl.name}' of struct '${decl.tag}' has incomplete type 'struct ${containedStruct.tag}' — `;
      diagnostics.push(err(memberDecl, `${prefix}${STRUCT_TYPED_MEMBER.message}`));
      valid = false;
      continue;
    }

    const words = sizeInWords(memberType);
    members.push({ name: memberDecl.name, type: memberType, offset: sizeWords });
    sizeWords += words;
  }

  if (!valid) return;
  type.members = members;
  type.sizeWords = sizeWords;
  type.complete = true;
}

// A `char` array's string-literal initializer is the ONE other
// context (besides printf's/scanf's format argument) a string literal is
// legal in. This validates the element type and that the literal leaves
// room for its own terminating NUL, and on success returns the exact words
// the array's storage should hold — the character codes, then the
// terminator, then zero padding out to `type.length` — built here, at the
// SOURCE, rather than left to codegen's own length-authoritative backstop
// (emitGlobalsSection's `initWords?.[i] ?? initValue ?? 0`): that backstop
// exists so a short array here can never misplace every global after it,
// but it should never be the ONLY thing making that true. Pushes at most
// one diagnostic and returns null on failure, shared verbatim between
// registerGlobal (a global) and checkLocalVarDecl (a local) so the two
// scopes cannot drift onto different rules for the same construct.
function checkStringArrayInit(
  type: ArrayType,
  init: StrLit,
  name: string,
  diagnostics: CcDiagnostic[],
): number[] | null {
  if (!typesEqual(type.of, 'char')) {
    diagnostics.push(
      err(
        init,
        `'${name}' is an array of '${typeName(type.of)}' and cannot be initialized from a string literal — only a 'char' array can be`,
      ),
    );
    return null;
  }
  const textWords = init.value.length + 1; // the characters, plus the terminating NUL
  if (textWords > type.length) {
    diagnostics.push(
      err(
        init,
        `the string literal needs ${textWords} words (including its terminating NUL), but '${name}' only has room for ${type.length}`,
      ),
    );
    return null;
  }
  const words: number[] = [];
  for (const ch of init.value) words.push(ch.charCodeAt(0));
  while (words.length < type.length) words.push(0); // terminator, then zero padding
  return words;
}

function arrayInitializerMessage(name: string): string {
  return `'${name}' is an array and can only be initialized from a string literal — assign its elements one at a time instead`;
}

function registerGlobal(
  decl: VarDecl,
  index: number,
  diagnostics: CcDiagnostic[],
  resolver: Resolver,
  globals: VarSymbol[],
  globalCursor: { next: number },
  types: TypeEnvironment,
): void {
  if (resolver.lookupInCurrentScope(decl.name)) {
    diagnostics.push(err(decl, `'${decl.name}' is already declared in this scope`));
    return;
  }

  const type = resolveTypeSpec(decl.typeSpec, diagnostics, decl, false, types, index);
  if (type === null) return;
  decl.resolvedType = type;
  if (!requireCompleteObject(type, decl.name, index, types, diagnostics, decl)) return;
  if (type === 'void') {
    diagnostics.push(err(decl, "'void' is only valid as a function's return type"));
  }
  if (decl.isConst && decl.init === undefined) {
    diagnostics.push(err(decl, `'${decl.name}' is declared const and must have an initializer`));
  }
  // A string literal (validated below, by checkStringArrayInit) is the one
  // legal array initializer; any other expression initializer on an array
  // is rejected here.
  let stringInitWords: number[] | null = null;
  if (isStruct(type) && decl.init !== undefined) {
    diagnostics.push(err(decl.init, STRUCT_ASSIGNMENT.message));
  }
  if (isArray(type) && decl.init !== undefined) {
    if (decl.init.kind !== 'StrLit') {
      diagnostics.push(err(decl, arrayInitializerMessage(decl.name)));
    } else {
      stringInitWords = checkStringArrayInit(type, decl.init, decl.name, diagnostics);
    }
  }

  const words = sizeInWords(type);
  const symbol: VarSymbol = {
    name: decl.name,
    type,
    storage: 'global',
    offset: globalCursor.next,
    initValue: 0,
  };
  if (stringInitWords) symbol.initWords = stringInitWords;
  globalCursor.next += words;
  if (decl.isConst) symbol.isConst = true;
  globals.push(symbol);
  resolver.declare(decl.name, {
    kind: 'var',
    symbol,
    isConst: decl.isConst,
    assigned: true,
    warnedUnassigned: false,
    declaredAt: index,
  });
}

function foldGlobalInit(
  decl: VarDecl,
  index: number,
  diagnostics: CcDiagnostic[],
  resolver: Resolver,
  types: TypeEnvironment,
): void {
  if (decl.init === undefined) return;
  const binding = resolver.fileScopeBinding(decl.name);
  if (!binding || binding.kind !== 'var') return; // duplicate already diagnosed
  // An array's initializer is a string literal or nothing at all — registerGlobal
  // (pass 1) already validated it and built initWords (or diagnosed it); folding
  // it as a constant EXPRESSION here would be wrong (a StrLit is not a constant
  // expression) and would double-diagnose the very case pass 1 just accepted.
  if (isArray(binding.symbol.type) || isStruct(binding.symbol.type)) return;
  if (!stampSizeofTypes(decl.init, diagnostics, types, index)) return;
  const value = foldConstExpr(decl.init, diagnostics, 'a global initializer');
  // A bool global's initializer is a conversion to bool: it holds only 0 or 1
  // by definition, so a nonzero fold becomes 1. Locals/params/returns
  // canonicalize in codegen; a global's initial word is fixed here.
  if (value !== null) {
    // Every constant-expression form foldGlobalInit accepts has type int in
    // this subset. Scalar targets already accept that conversion; the missing
    // boundary was a pointer target initialized from a nonzero integer. Use
    // the same conversion rule and exact diagnostic as a local initializer,
    // while retaining integer constant expressions that fold to NULL.
    if (
      isPointer(binding.symbol.type) &&
      !checkAssignableConversion('int', binding.symbol.type, decl.init, diagnostics)
    ) {
      diagnostics.push(
        err(
          decl.init,
          `cannot initialize '${decl.name}' of type '${typeName(binding.symbol.type)}' with a value of type 'int'`,
        ),
      );
      return;
    }
    binding.symbol.initValue = binding.symbol.type === 'bool' ? (value !== 0 ? 1 : 0) : value;
  }
}

function registerFunction(
  decl: FuncDecl,
  index: number,
  diagnostics: CcDiagnostic[],
  resolver: Resolver,
  types: TypeEnvironment,
): void {
  // Resolved BEFORE the existing-kind-var check below (and before every
  // other early return in this function): checkFunctionBody (pass 2) always
  // runs for a decl with a body, regardless of how pass 1 ends here, and it
  // reads decl.resolvedReturnType/param.resolvedType unconditionally. An
  // early return above this point would leave those stamps unset, and pass 2
  // would silently fall back to 'int' instead of the real type.
  const resolvedReturn = resolveTypeSpec(decl.returnSpec, diagnostics, decl, false, types, index);
  let signatureTypeValid = resolvedReturn !== null;
  let returnType: CType = resolvedReturn ?? 'int';
  if (isArray(returnType)) {
    diagnostics.push(
      err(
        decl,
        'a function cannot return an array — return a pointer to its first element instead',
      ),
    );
    returnType = 'int';
  }
  if (isStruct(returnType)) {
    diagnostics.push(err(decl, STRUCT_RETURN.message));
    // Keep the invalid signature on the checker's one-word recovery path so a
    // body can still be visited without placing an aggregate in its frame.
    returnType = 'int';
  }
  decl.resolvedReturnType = returnType;

  const paramTypes = decl.params.map((p) => {
    const resolvedParam = resolveTypeSpec(p.typeSpec, diagnostics, p, true, types, index);
    if (resolvedParam === null) signatureTypeValid = false;
    const paramType = resolvedParam ?? 'int';
    if (isStruct(paramType)) diagnostics.push(err(p, STRUCT_BY_VALUE_ARGUMENT.message));
    p.resolvedType = paramType;
    return paramType;
  });

  const existing = resolver.lookupInCurrentScope(decl.name);
  if (existing && existing.kind === 'var') {
    diagnostics.push(err(decl, `'${decl.name}' is already declared in this scope`));
    return;
  }

  // main is the entry point crt0 calls, and crt0 pushes no arguments and
  // reads main's return value as the program's status — so the only shapes
  // that run correctly are `int main(void)` and its empty-list synonym
  // `int main()` (both parse to zero params). Any other signature (extra
  // parameters, a non-int return) would read incidental stack residue or be
  // ignored, so reject it here, before codegen. Checked once, on the first
  // declaration of main (a later redeclaration is caught as a conflict);
  // this restriction applies to main alone, never to other functions.
  if (decl.name === 'main' && !existing) {
    if (returnType !== 'int' || decl.params.length > 0) {
      diagnostics.push(
        err(
          decl,
          "'main' must be declared 'int main(void)' — it is the program's entry point and the runtime calls it with no arguments",
        ),
      );
    }
  }

  if (existing) {
    // putchar/getchar/printf/scanf/strcmp/strcpy/malloc/free are provided by
    // RUNTIME_SECTIONS (runtime.ts), which defines an F_<name> label for
    // each. Without this check, a user function whose signature happens to
    // match the builtin's (e.g. `int printf(char* fmt) { ... }`) would
    // slip past the sameSignature/hasBody checks below silently (the
    // builtin's own hasBody is false, so "already defined" never fires)
    // and codegen would emit a SECOND `F_printf` label, which the
    // assembler rejects with a raw "duplicate label" error the student
    // never asked for. Reject by name up front, regardless of whether
    // the user's signature happens to match.
    if (existing.isBuiltin && decl.body) {
      diagnostics.push(
        err(
          decl,
          `'${decl.name}' is a built-in function provided by the runtime library and cannot be redefined`,
        ),
      );
      return;
    }
    // A precise TypeSpec diagnostic already owns this declaration. Do not
    // compare recovery `int` placeholders against the existing signature and
    // add a misleading generic conflict (notably for source-spelled matching
    // malloc/free prototypes, whose void * spelling is the real boundary).
    if (!signatureTypeValid) return;
    const sameSignature =
      typesEqual(existing.returnType, returnType) &&
      existing.params.length === paramTypes.length &&
      existing.params.every((t, i) => typesEqual(t, paramTypes[i]));
    if (!sameSignature) {
      diagnostics.push(err(decl, `conflicting declaration of function '${decl.name}'`));
      return;
    }
    if (existing.hasBody && decl.body) {
      diagnostics.push(err(decl, `function '${decl.name}' is already defined`));
      return;
    }
    if (decl.body) existing.hasBody = true;
    return;
  }

  resolver.declare(decl.name, {
    kind: 'func',
    name: decl.name,
    returnType,
    params: paramTypes,
    variadic: false,
    isBuiltin: false,
    hasBody: !!decl.body,
    declaredAt: index,
  });
}

function checkFunctionBody(
  decl: FuncDecl,
  index: number,
  diagnostics: CcDiagnostic[],
  resolver: Resolver,
  functions: Map<string, FuncFrame>,
  types: TypeEnvironment,
): void {
  // Parameters and the function's outermost body are ONE scope: a
  // body local repeating a parameter name is a redeclaration, not a shadow.
  resolver.pushScope();
  const params: VarSymbol[] = [];
  decl.params.forEach((param, i) => {
    if (param.name === null) {
      diagnostics.push(err(param, 'a function with a body must name every parameter'));
      return;
    }
    if (resolver.lookupInCurrentScope(param.name)) {
      diagnostics.push(err(param, `duplicate parameter name '${param.name}'`));
      return;
    }
    // Not resolveTypeSpec again here: registerFunction (pass 1) already
    // resolved (and diagnosed) this exact param.typeSpec for every FuncDecl,
    // prototype or defined, before this file ever reaches pass 2 — calling it
    // again here would duplicate the same diagnostic at the same position for
    // a defined function's parameters. Read the stamp it left instead. The
    // `?? 'int'` fallback is the AST field's optional typing only — pass 1
    // always stamps this before pass 2 ever runs, even on its early returns.
    const type = param.resolvedType ?? 'int';
    if (type === 'void') {
      diagnostics.push(err(param, "'void' is only valid as a function's return type"));
    }
    const symbol: VarSymbol = {
      name: param.name,
      type,
      storage: 'param',
      offset: 4 + i,
    };
    resolver.declare(param.name, {
      kind: 'var',
      symbol,
      isConst: false,
      assigned: true,
      warnedUnassigned: false,
      declaredAt: ALWAYS_VISIBLE,
    });
    params.push(symbol);
  });

  // Read the stamp registerFunction (pass 1) already left instead of
  // re-resolving decl.returnSpec — same reasoning as the param loop above.
  const returnType = decl.resolvedReturnType ?? 'int';
  const ctx: Ctx = {
    diagnostics,
    resolver,
    types,
    currentDeclIndex: index,
    initializing: null,
    locals: [],
    nextLocalOffset: 0,
    returnType,
    loopDepth: 0,
    switchDepth: 0,
  };

  // The body's statements are checked directly in the param scope — NOT via
  // checkBlock, which would push a second scope and split params from body.
  checkStmtList(decl.body!.stmts, ctx);
  resolver.popScope();

  if (returnType !== 'void' && !alwaysReturnsValue(decl.body!)) {
    diagnostics.push(warn(decl, `function '${decl.name}' may not return a value on every path`));
  }

  const frame: FuncFrame = { name: decl.name, returnType, params, locals: ctx.locals };
  const localWords = localWordCount(frame);
  if (localWords > MAX_FRAME_WORDS) {
    diagnostics.push(
      err(
        decl,
        `function '${decl.name}' needs ${localWords} words of local storage, more than the LC-3 frame allows (${MAX_FRAME_WORDS} maximum)`,
      ),
    );
  }
  functions.set(decl.name, frame);
}

// Simple structural rule, not flow analysis (matching the specified subset): a
// Return counts as "returns a value" only if it carries an expression (a
// bare `return;` in a non-void function is therefore treated the same as
// falling off the end — both are "missing return" on that path). A Block
// defers to its last statement; an If only satisfies the rule when it has
// an else and both arms satisfy it. Nothing else (loops, switch) is
// special-cased, so e.g. a switch as the last statement always warns.
function alwaysReturnsValue(stmt: Stmt): boolean {
  switch (stmt.kind) {
    case 'Return':
      return stmt.expr !== undefined;
    case 'If':
      return stmt.else !== null && alwaysReturnsValue(stmt.then) && alwaysReturnsValue(stmt.else);
    case 'Block':
      return stmt.stmts.length > 0 && alwaysReturnsValue(stmt.stmts[stmt.stmts.length - 1]);
    default:
      return false;
  }
}

function checkBlock(block: Block, ctx: Ctx): void {
  ctx.resolver.pushScope();
  checkStmtList(block.stmts, ctx);
  ctx.resolver.popScope();
}

function checkStmtList(stmts: Stmt[], ctx: Ctx): void {
  for (const s of stmts) checkStmt(s, ctx);
}

function checkStmt(stmt: Stmt, ctx: Ctx): void {
  switch (stmt.kind) {
    case 'VarDecl':
      checkLocalVarDecl(stmt, ctx);
      break;
    case 'Block':
      checkBlock(stmt, ctx);
      break;
    case 'If':
      checkIf(stmt, ctx);
      break;
    case 'While':
      checkCondExpr(stmt.cond, ctx);
      ctx.loopDepth++;
      checkStmt(stmt.body, ctx);
      ctx.loopDepth--;
      break;
    case 'DoWhile':
      ctx.loopDepth++;
      checkStmt(stmt.body, ctx);
      ctx.loopDepth--;
      checkCondExpr(stmt.cond, ctx);
      break;
    case 'For':
      checkFor(stmt, ctx);
      break;
    case 'Switch':
      checkSwitch(stmt, ctx);
      break;
    case 'Return':
      checkReturn(stmt, ctx);
      break;
    case 'Break':
      if (ctx.loopDepth === 0 && ctx.switchDepth === 0) {
        ctx.diagnostics.push(err(stmt, "'break' outside of a loop or switch"));
      }
      break;
    case 'Continue':
      if (ctx.loopDepth === 0) {
        ctx.diagnostics.push(err(stmt, "'continue' outside of a loop"));
      }
      break;
    case 'ExprStmt':
      if (stmt.expr) checkDiscardedExpr(stmt.expr, ctx);
      break;
  }
}

// Every VarDecl that reaches here is a genuine block-item: one spliced into
// a compound block or switch case by parseStmtList, or a for-init. A
// declaration in an unbraced controlled-statement slot (`if (x) int y = 1;`)
// never reaches the checker — the parser rejects it outright (parser.ts's
// declAsControlledStatementMessage), since real C doesn't allow it either.
function checkLocalVarDecl(decl: VarDecl, ctx: Ctx): void {
  const existing = ctx.resolver.lookupInCurrentScope(decl.name);
  if (existing) {
    const asParam = existing.kind === 'var' && existing.symbol.storage === 'param';
    ctx.diagnostics.push(
      err(
        decl,
        asParam
          ? `'${decl.name}' is already declared in this scope (as a parameter)`
          : `'${decl.name}' is already declared in this scope`,
      ),
    );
    return;
  }
  const type = resolveTypeSpec(
    decl.typeSpec,
    ctx.diagnostics,
    decl,
    false,
    ctx.types,
    ctx.currentDeclIndex,
  );
  if (type === null) return;
  decl.resolvedType = type;
  if (
    !requireCompleteObject(type, decl.name, ctx.currentDeclIndex, ctx.types, ctx.diagnostics, decl)
  ) {
    return;
  }
  if (type === 'void') {
    ctx.diagnostics.push(err(decl, "'void' is only valid as a function's return type"));
  }
  if (decl.isConst && decl.init === undefined) {
    ctx.diagnostics.push(
      err(decl, `'${decl.name}' is declared const and must have an initializer`),
    );
  }
  // A string literal (validated below, by checkStringArrayInit) is the one
  // legal array initializer; any other expression initializer on an array
  // is rejected here.
  if (isArray(type) && decl.init !== undefined && decl.init.kind !== 'StrLit') {
    ctx.diagnostics.push(err(decl, arrayInitializerMessage(decl.name)));
  }

  // Bind the local BEFORE checking its initializer: the name is in
  // scope inside its own initializer (C semantics), so a same-named global
  // does not silently satisfy `int x = x;`. It starts unassigned, so reading
  // it there is the "read in its own initializer" error (see checkIdentUse).
  const symbol: VarSymbol = {
    name: decl.name,
    type,
    storage: 'local',
    offset: allocateLocal(ctx, type),
  };
  const binding: VarBinding = {
    kind: 'var',
    symbol,
    isConst: decl.isConst,
    assigned: false,
    warnedUnassigned: false,
    declaredAt: ALWAYS_VISIBLE,
  };
  ctx.resolver.declare(decl.name, binding);
  ctx.locals.push(symbol);
  decl.resolved = symbol; // stamp for codegen (same slot on both passes)

  if (decl.init !== undefined) {
    if (isArray(type) && decl.init.kind === 'StrLit') {
      // No identifier is read here, so none of the use-before-assignment/
      // initializing-itself bookkeeping below applies — and checkValue would
      // reject a bare StrLit outright (STRING_LITERAL_CONTEXT). This is the
      // checker's own dedicated validation instead, shared verbatim with
      // registerGlobal's identical case.
      const words = checkStringArrayInit(type, decl.init, decl.name, ctx.diagnostics);
      if (words) symbol.initWords = words;
    } else if (isStruct(type)) {
      ctx.diagnostics.push(err(decl.init, STRUCT_ASSIGNMENT.message));
      // Still visit the initializer for ordinary name/type diagnostics. A
      // plain struct identifier returns its type here without crossing a
      // value-consuming boundary, so the canonical copy error stays singular.
      checkExpr(decl.init, ctx, false);
    } else {
      const prev = ctx.initializing;
      ctx.initializing = symbol;
      const valueType = checkValue(decl.init, ctx);
      ctx.initializing = prev;
      // This initializer path validates the value's type against the
      // declared type — the same boundary
      // checkReturn closes for `return` (isAssignable's 3-arg form, comment
      // there). Before this, `int x = &y;`, `int *p = 5;`, and
      // `int **q = &y;` all compiled clean while the identical mismatch as a
      // separate assignment (`int x; x = &y;`) was already correctly
      // rejected by checkAssign — one remaining place a value crossed a
      // declared type boundary unchecked.
      if (valueType !== 'error' && isStruct(valueType)) {
        ctx.diagnostics.push(err(decl.init, STRUCT_ASSIGNMENT.message));
      } else if (
        valueType !== 'error' &&
        !checkAssignableConversion(valueType, type, decl.init, ctx.diagnostics)
      ) {
        ctx.diagnostics.push(
          err(
            decl.init,
            `cannot initialize '${decl.name}' of type '${typeName(type)}' with a value of type '${typeName(valueType)}'`,
          ),
        );
      }
    }
    binding.assigned = true;
  }
}

function checkIf(stmt: If, ctx: Ctx): void {
  checkCondExpr(stmt.cond, ctx);
  checkStmt(stmt.then, ctx);
  if (stmt.else !== null) checkStmt(stmt.else, ctx);
}

function checkFor(stmt: For, ctx: Ctx): void {
  ctx.resolver.pushScope();
  if (stmt.init) {
    if (Array.isArray(stmt.init)) {
      for (const decl of stmt.init) checkLocalVarDecl(decl, ctx);
    } else {
      checkDiscardedExpr(stmt.init, ctx);
    }
  }
  if (stmt.cond) checkCondExpr(stmt.cond, ctx);
  if (stmt.update) checkDiscardedExpr(stmt.update, ctx);
  ctx.loopDepth++;
  checkStmt(stmt.body, ctx);
  ctx.loopDepth--;
  ctx.resolver.popScope();
}

function checkDiscardedExpr(expr: Expr, ctx: Ctx): void {
  const type = checkExpr(expr, ctx, false);
  if (type !== 'error' && isStruct(type)) {
    ctx.diagnostics.push(err(expr, STRUCT_SCALAR_VALUE_MESSAGE));
  }
}

// A bare assignment used as a condition is usually an equality typo.
// Only fires when the assignment IS the condition, not when it's buried
// inside a larger expression. Shared with checkSwitch, which
// cannot use checkCondExpr wholesale — it needs the expression's type for
// its own integral-type error below.
function warnAssignmentAsCondition(cond: Expr, ctx: Ctx): void {
  if (cond.kind === 'Assign' && cond.op === '=') {
    ctx.diagnostics.push(warn(cond, "assignment used as a condition — did you mean '=='?"));
  }
}

function checkCondExpr(cond: Expr, ctx: Ctx): void {
  warnAssignmentAsCondition(cond, ctx);
  const type = checkValue(cond, ctx);
  if (type !== 'error' && isStruct(type)) {
    ctx.diagnostics.push(err(cond, STRUCT_CONDITION_MESSAGE));
  }
}

function isIntegralType(type: CType): boolean {
  return isScalar(type) && type !== 'void';
}

function checkSwitch(stmt: Switch, ctx: Ctx): void {
  warnAssignmentAsCondition(stmt.expr, ctx);
  const t = checkExpr(stmt.expr, ctx, false);
  if (t !== 'error' && isStruct(t)) {
    ctx.diagnostics.push(err(stmt.expr, STRUCT_CONDITION_MESSAGE));
  } else if (t !== 'error' && !isIntegralType(t)) {
    ctx.diagnostics.push(
      err(stmt.expr, 'a switch expression must have an integral type (int, char, or bool)'),
    );
  }

  const seen = new Map<number, SwitchCase>();
  let defaultSeen = false;
  for (const c of stmt.cases) {
    if (c.value === null) {
      if (defaultSeen) {
        ctx.diagnostics.push(err(c, "a switch may only have one 'default' label"));
      }
      defaultSeen = true;
      continue;
    }
    if (!stampSizeofTypes(c.value, ctx.diagnostics, ctx.types, ctx.currentDeclIndex)) continue;
    const v = foldConstExpr(c.value, ctx.diagnostics, 'a case label');
    if (v === null) continue;
    const prior = seen.get(v);
    if (prior) {
      ctx.diagnostics.push(err(c.value, `duplicate case value ${v}`));
    } else {
      seen.set(v, c);
    }
  }

  ctx.switchDepth++;
  ctx.resolver.pushScope(); // one shared scope: fall-through means cases aren't separate blocks
  for (const c of stmt.cases) checkStmtList(c.stmts, ctx);
  ctx.resolver.popScope();
  ctx.switchDepth--;
}

function checkReturn(stmt: Return, ctx: Ctx): void {
  if (stmt.expr === undefined) return;
  if (ctx.returnType === 'void') {
    const valueType = checkExpr(stmt.expr, ctx, false);
    ctx.diagnostics.push(
      err(
        stmt,
        valueType !== 'error' && isStruct(valueType)
          ? STRUCT_RETURN.message
          : 'a void function cannot return a value',
      ),
    );
    return;
  }
  const valueType = checkValue(stmt.expr, ctx);
  if (valueType !== 'error' && isStruct(valueType)) {
    ctx.diagnostics.push(err(stmt.expr, STRUCT_RETURN.message));
    return;
  }
  // The same rule checkAssign/checkCall already apply to a target/parameter,
  // applied at the one remaining place a value crosses a declared type
  // boundary unchecked: a `return`. isAssignable's 3-arg form lets a literal
  // 0/NULL convert to a pointer return type, and still rejects any other
  // scalar-to-pointer mismatch, exactly like `p = 5;` or `f(5)` already do.
  // registerFunction already forces an array return type down to 'int'
  // before this ever runs, so that pre-existing diagnostic never doubles up
  // with this one.
  if (
    valueType !== 'error' &&
    !checkAssignableConversion(valueType, ctx.returnType, stmt.expr, ctx.diagnostics)
  ) {
    ctx.diagnostics.push(
      err(
        stmt.expr,
        `cannot return a value of type '${typeName(valueType)}' from a function returning '${typeName(ctx.returnType)}'`,
      ),
    );
  }
}

// ---- expressions ----

function structOperatorMessage(op: string): string {
  if (op === '==' || op === '!=') {
    return "whole structs cannot be compared with '==' or '!=' — compare the members you need, or compare pointers to the structs";
  }
  return `'${op}' cannot be applied to a whole struct — use a scalar member or a pointer to the struct`;
}

const STRUCT_CONDITION_MESSAGE =
  'a whole struct cannot be used as a condition — test a scalar member or compare a pointer with NULL';
const STRUCT_SCALAR_VALUE_MESSAGE =
  'a whole struct cannot be used as a scalar value here — select a member or use a pointer to the struct';

function checkArgumentValue(expr: Expr, ctx: Ctx, live: boolean): CType | 'error' {
  const type = checkValue(expr, ctx, live);
  if (type === 'error' || !isStruct(type)) return type;
  ctx.diagnostics.push(err(expr, STRUCT_BY_VALUE_ARGUMENT.message));
  return 'error';
}

// Names an identifier occurrence that did NOT resolve to a variable:
// a visible function used where a variable is needed, a file-scope name whose
// declaration comes later (declare-before-use), or an entirely undeclared name.
// `binding` is whatever resolve() returned (a func binding, or undefined).
function reportNotAVariable(ident: Ident, ctx: Ctx, binding: Binding | undefined): void {
  if (binding && binding.kind === 'func') {
    ctx.diagnostics.push(
      err(ident, `'${ident.name}' is a function — call it with ${ident.name}(...)`),
    );
    return;
  }
  if (ctx.resolver.declaredLater(ident.name, ctx.currentDeclIndex)) {
    ctx.diagnostics.push(err(ident, `'${ident.name}' is used before its declaration`));
    return;
  }
  ctx.diagnostics.push(err(ident, `'${ident.name}' is not declared`));
}

// Use-before-assignment is an order-based scan, not flow analysis: `assigned`
// flips true the moment an assignment is walked in source order, with no
// awareness of which branch it's in. This means false negatives on
// single-branch assignment — `if (cond) x = 1; use(x);` never warns, even
// though x is still unassigned when cond is false at runtime. A warning
// here is always accurate; the absence of one is not proof the variable is
// safe.
function checkIdentUse(expr: Ident, ctx: Ctx): CType | 'error' {
  const binding = ctx.resolver.resolve(expr.name, ctx.currentDeclIndex);
  if (!binding || binding.kind !== 'var') {
    reportNotAVariable(expr, ctx, binding);
    return 'error';
  }
  expr.resolved = binding.symbol; // stamp: codegen reads the SAME slot
  // Reading a local inside its own initializer, before it holds a value, is an
  // error — not the softer use-before-assigned warning.
  if (ctx.initializing === binding.symbol) {
    if (!binding.warnedUnassigned) {
      ctx.diagnostics.push(err(expr, `'${expr.name}' is read in its own initializer`));
      binding.warnedUnassigned = true;
    }
    return binding.symbol.type;
  }
  // An array identifier names a fixed place the moment it is declared (book
  // 16.3.5) — unlike a scalar or pointer, it has no separate "assigned a
  // value" moment (whole-array assignment is forbidden entirely; see
  // checkAssign's array-reassign guard), so reading it to decay to a pointer
  // is never a use-before-assignment. Only its CONTENTS can be
  // uninitialized, and this subset does not track that at the element level.
  if (
    !binding.assigned &&
    !binding.warnedUnassigned &&
    !isArray(binding.symbol.type) &&
    !isStruct(binding.symbol.type)
  ) {
    ctx.diagnostics.push(warn(expr, `'${expr.name}' may be used before it is assigned a value`));
    binding.warnedUnassigned = true;
  }
  return binding.symbol.type;
}

// book 16.3.5: an array identifier names a fixed place — never reassignable
// OR incrementable/decrementable as a whole. Shared by checkAssign's `=`
// path and checkLvalueReadWrite (compound assignment AND ++/--), so the two
// paths cannot drift apart on this rule again the way they did before this
// was factored out (checkAssign alone rejected `a = b;`, but neither
// checkAssign's compound path nor checkUnary's ++/-- caught `a++` or
// `a += 1` before routing through here).
function rejectArrayTarget(target: Expr, type: CType | 'error', ctx: Ctx): CType | 'error' {
  if (type !== 'error' && isArray(type)) {
    ctx.diagnostics.push(
      err(target, 'an array cannot be reassigned — it names a fixed place in memory'),
    );
    return 'error';
  }
  return type;
}

// Resolves an lvalue target for a read-then-write use (compound assignment,
// ++/--). `a[0]++` and `(*p)--` are genuine lvalues (isLvalue), so they type
// through checkExpr exactly like any other value; only a plain Ident gets
// the extra const/use-before-assignment bookkeeping below, since that
// bookkeeping is per-VARIABLE and a Subscript/Member/Deref target isn't one.
// AddrOf is NOT an lvalue (see isLvalue's comment) — `(&x)++` falls through
// to the permanent "must be a variable" message below, and that is correct,
// so do NOT special-case it to a pointer-support message.
// `live` threads through to checkExpr for the same reason checkAssign's `=`
// path threads it (a Deref/Subscript/Member operand can itself contain a
// div-by-zero/shift-range diagnostic that must respect this operation's own
// reachability, e.g. a provably-dead `0 && (*(p + 1/0) += 1)`).
// Returns the target's type, or 'error' if it isn't a usable lvalue.
function checkLvalueReadWrite(
  target: Expr,
  ctx: Ctx,
  opName: string,
  live: boolean,
): CType | 'error' {
  if (!isLvalue(target)) {
    ctx.diagnostics.push(err(target, `the operand of '${opName}' must be a variable`));
    return 'error';
  }
  if (target.kind !== 'Ident') {
    return rejectArrayTarget(target, checkExpr(target, ctx, false, live), ctx);
  }
  const binding = ctx.resolver.resolve(target.name, ctx.currentDeclIndex);
  if (!binding || binding.kind !== 'var') {
    reportNotAVariable(target, ctx, binding);
    return 'error';
  }
  target.resolved = binding.symbol; // stamp for codegen
  if (binding.isConst) {
    ctx.diagnostics.push(err(target, `cannot assign to '${target.name}' — it is declared const`));
  }
  // An array identifier is never "assigned" as a whole (see checkIdentUse's
  // identical exemption) — only its CONTENTS can be uninitialized, which
  // this subset does not track at the element level.
  if (
    !binding.assigned &&
    !binding.warnedUnassigned &&
    !isArray(binding.symbol.type) &&
    !isStruct(binding.symbol.type)
  ) {
    ctx.diagnostics.push(
      warn(target, `'${target.name}' may be used before it is assigned a value`),
    );
    binding.warnedUnassigned = true;
  }
  binding.assigned = true;
  return rejectArrayTarget(target, binding.symbol.type, ctx);
}

function checkUnary(expr: Unary, ctx: Ctx, live: boolean): CType | 'error' {
  if (expr.op === '++' || expr.op === '--') {
    const type = checkLvalueReadWrite(expr.expr, ctx, expr.op, live);
    if (type === 'error') return 'error';
    if (isStruct(type)) {
      ctx.diagnostics.push(err(expr, structOperatorMessage(expr.op)));
      return 'error';
    }
    const pointee = pointeeOf(type);
    if (pointee !== null && !requireCompletePointerArithmetic(pointee, expr, ctx)) {
      return 'error';
    }
    return type;
  }
  const t = checkValue(expr.expr, ctx, live);
  if (t === 'error') return 'error';
  if (isStruct(t)) {
    ctx.diagnostics.push(err(expr, structOperatorMessage(expr.op)));
    return 'error';
  }
  // `!` stays permissive (a pointer is a legal truth value, book 16.2.2.3's
  // NULL-check idiom); `-`/`~` on a pointer or decayed array is meaningless
  // and is therefore rejected with an operator-specific
  // diagnostic.
  if ((expr.op === '-' || expr.op === '~') && pointeeOf(t) !== null) {
    ctx.diagnostics.push(err(expr, `'${expr.op}' cannot be applied to '${typeName(t)}'`));
    return 'error';
  }
  return 'int';
}

function checkAssign(expr: Assign, ctx: Ctx, live: boolean): CType | 'error' {
  const valueType = checkValue(expr.value, ctx, live);

  // `x /= 0` / `x %= 0` lower through the same RTDIV/RTMOD runtime
  // call as `x = x / 0` and hang identically inside op-divmod — catch a
  // constant-zero divisor here too.
  // Same gate as the Binary `/`/`%` case: `live` (never a provably-dead branch)
  // and the divisor const-folds to exactly 0 (a variable folds to null).
  if (live && (expr.op === '/=' || expr.op === '%=') && constFoldProbe(expr.value) === 0) {
    ctx.diagnostics.push(err(expr, 'division by zero — the divisor is always 0'));
  }

  // `x <<= 32` / `x >>= 32` lower through the same shift loop as
  // `x = x << 32` and share its out-of-range diagnostic. Same gate as the
  // Binary shift case: live, and the count const-folds outside 0..15.
  if (live && (expr.op === '<<=' || expr.op === '>>=')) {
    const count = constFoldProbe(expr.value);
    if (count !== null && !isShiftCountInRange(count)) {
      ctx.diagnostics.push(shiftCountError(expr, count));
    }
  }

  // Only a variable, an array element, a dereference, or a struct member may
  // be the target. `&expr` is excluded because the result of `&` is never an
  // lvalue under C's rules; the diagnostic therefore does not mention pointer
  // support.
  if (!isLvalue(expr.target)) {
    ctx.diagnostics.push(err(expr.target, 'the left side of an assignment must be a variable'));
    return 'error';
  }

  let targetType: CType | 'error';
  if (expr.op === '=' && expr.target.kind === 'Ident') {
    const binding = ctx.resolver.resolve(expr.target.name, ctx.currentDeclIndex);
    if (!binding || binding.kind !== 'var') {
      reportNotAVariable(expr.target, ctx, binding);
      targetType = 'error';
    } else {
      expr.target.resolved = binding.symbol; // stamp for codegen
      if (binding.isConst) {
        ctx.diagnostics.push(
          err(expr.target, `cannot assign to '${expr.target.name}' — it is declared const`),
        );
      }
      binding.assigned = true;
      targetType = binding.symbol.type;
    }
  } else if (expr.op === '=') {
    // Deref/Subscript/Member target: no per-variable bookkeeping (const,
    // use-before-assignment) applies to an array element, member, or pointee —
    // checkExpr's own type rules (checkDeref/checkSubscript/checkMember) are
    // all there is. `live` threads through so a div-by-zero/shift-range
    // diagnostic inside the target's own subexpressions (e.g.
    // `*(a + 1/0) = 5;`) still respects this assignment's own reachability.
    targetType = checkExpr(expr.target, ctx, false, live);
  } else {
    targetType = checkLvalueReadWrite(expr.target, ctx, expr.op, live);
  }

  // book 16.3.5: an array identifier names a fixed place and is never
  // reassignable wholesale — checked before the general assignability rule
  // below so the message names the real reason, not a generic type mismatch.
  // A no-op when targetType already came back 'error' from checkLvalueReadWrite
  // (which applies this same rejectArrayTarget check itself for the compound-
  // assignment path), so an array compound-assigned (`a += 1;`) is never
  // reported twice.
  targetType = rejectArrayTarget(expr.target, targetType, ctx);
  if (targetType === 'error') {
    if (valueType !== 'error' && isStruct(valueType)) {
      ctx.diagnostics.push(
        err(expr, expr.op === '=' ? STRUCT_ASSIGNMENT.message : structOperatorMessage(expr.op)),
      );
    }
    return 'error';
  }

  if (isStruct(targetType) || (valueType !== 'error' && isStruct(valueType))) {
    ctx.diagnostics.push(
      err(expr, expr.op === '=' ? STRUCT_ASSIGNMENT.message : structOperatorMessage(expr.op)),
    );
    return 'error';
  }

  if (expr.op !== '=' && valueType !== 'error') {
    const targetPointee = pointeeOf(targetType);
    const valueIsPointer = pointeeOf(valueType) !== null;
    if (targetPointee !== null) {
      if ((expr.op !== '+=' && expr.op !== '-=') || !isIntegralType(valueType)) {
        ctx.diagnostics.push(
          err(
            expr,
            `'${expr.op}' cannot be applied to '${typeName(targetType)}' and '${typeName(valueType)}'`,
          ),
        );
        return 'error';
      }
      if (!requireCompletePointerArithmetic(targetPointee, expr, ctx)) return 'error';
      expr.pointerScale = sizeInWords(targetPointee);
    } else if (valueIsPointer) {
      ctx.diagnostics.push(
        err(
          expr,
          `'${expr.op}' cannot be applied to '${typeName(targetType)}' and '${typeName(valueType)}'`,
        ),
      );
      return 'error';
    }
  }

  // Plain assignment's value must actually fit the target's type — the rule
  // that rejects `p = c;` (mismatched pointer types) and accepts `p = 0;`
  // (the null pointer constant) alike. Compound assignment (`+=` and
  // friends) never reached a type check here before pointers existed either
  // (every scalar interconverts) and still doesn't — its operand
  // typing is checkPointerBinary's and the existing scalar rules', not this.
  if (
    expr.op === '=' &&
    valueType !== 'error' &&
    !checkAssignableConversion(valueType, targetType, expr.value, ctx.diagnostics)
  ) {
    ctx.diagnostics.push(
      err(
        expr.target,
        `cannot assign a value of type '${typeName(valueType)}' to '${typeName(targetType)}'`,
      ),
    );
    return 'error';
  }

  return targetType;
}

function checkAddrOf(expr: AddrOf, ctx: Ctx, live: boolean): CType | 'error' {
  if (!isLvalue(expr.expr)) {
    ctx.diagnostics.push(
      err(
        expr,
        "'&' needs an lvalue — a variable, an array element, a dereference, or a struct member",
      ),
    );
    checkExpr(expr.expr, ctx, false, live);
    return 'error';
  }
  const t = checkAddrOfOperand(expr.expr, ctx, live);
  return t === 'error' ? 'error' : ptr(t);
}

function checkCast(expr: Cast, ctx: Ctx, live: boolean): CType | 'error' {
  // Resolve the written target first. In particular, a source-spelled
  // `(void *)` is owned solely by VOID_POINTER_TYPE and must not also receive
  // the broader cast-boundary diagnostic below.
  const target = resolveTypeSpec(
    expr.spec,
    ctx.diagnostics,
    expr,
    false,
    ctx.types,
    ctx.currentDeclIndex,
  );
  if (target === null) return 'error';

  const operand = checkValue(expr.expr, ctx, live);
  if (operand === 'error') return 'error';
  if (isPointer(target) && target.to !== 'void' && isExactVoidPointer(operand)) {
    return target;
  }

  ctx.diagnostics.push(err(expr, CAST_BEYOND_MALLOC_RESULT.message));
  return 'error';
}

// Taking a variable's address is not a READ of its value — only its
// location is inspected, never its contents — so it must not trigger (or
// count toward) the use-before-assignment warning the way checkIdentUse's
// ordinary read path does. It marks the variable assigned instead, because
// this checker cannot follow a write made later through the resulting
// pointer, and the alternative is a false "may be used before it is
// assigned" warning on every later read of every variable ever addressed —
// the common `scanf("%d", &x)` shape. A Deref/Subscript/Member operand has no such
// per-variable bookkeeping to skip (see checkLvalueReadWrite's identical
// reasoning), so it types through checkExpr exactly like any other value.
function checkAddrOfOperand(expr: Expr, ctx: Ctx, live: boolean): CType | 'error' {
  if (expr.kind !== 'Ident') {
    return checkExpr(expr, ctx, false, live);
  }
  const binding = ctx.resolver.resolve(expr.name, ctx.currentDeclIndex);
  if (!binding || binding.kind !== 'var') {
    reportNotAVariable(expr, ctx, binding);
    return 'error';
  }
  expr.resolved = binding.symbol; // stamp for codegen
  if (binding.isConst) {
    ctx.diagnostics.push(
      err(
        expr,
        `cannot take the address of '${expr.name}' — const-qualified pointers are not supported by this C subset`,
      ),
    );
    return 'error';
  }
  binding.assigned = true;
  return binding.symbol.type;
}

function checkDeref(expr: Deref, ctx: Ctx, live: boolean): CType | 'error' {
  const t = checkValue(expr.expr, ctx, live);
  if (t === 'error') return 'error';
  if (isStruct(t)) {
    ctx.diagnostics.push(err(expr, structOperatorMessage('*')));
    return 'error';
  }
  const pointee = pointeeOf(t);
  if (pointee === null) {
    ctx.diagnostics.push(err(expr, `'*' needs a pointer, but this is '${typeName(t)}'`));
    return 'error';
  }
  expr.resolvedType = pointee; // stamp for codegen's lvalueTypeOf
  return pointee;
}

// a[i] is *(a + i) — the book's own equivalence (Table 16.1), enforced as
// one rule rather than a parallel one.
function checkSubscript(expr: Subscript, ctx: Ctx, live: boolean): CType | 'error' {
  const base = checkValue(expr.array, ctx, live);
  const index = checkValue(expr.index, ctx, live);
  if (base === 'error' || index === 'error') return 'error';
  if (isStruct(base) || isStruct(index)) {
    ctx.diagnostics.push(err(expr, structOperatorMessage('[]')));
    return 'error';
  }
  const pointee = pointeeOf(base);
  if (pointee === null) {
    ctx.diagnostics.push(
      err(expr, `only a pointer or an array can be subscripted, not '${typeName(base)}'`),
    );
    return 'error';
  }
  if (!requireCompletePointerArithmetic(pointee, expr, ctx)) return 'error';
  if (!isScalar(index) || index === 'void') {
    ctx.diagnostics.push(
      err(expr.index, `an array index must be a whole number, not '${typeName(index)}'`),
    );
    return 'error';
  }
  expr.resolvedType = pointee; // stamp for codegen's lvalueTypeOf
  return pointee;
}

function checkMember(expr: Member, ctx: Ctx, live: boolean): CType | 'error' {
  // `.` consumes only the location of its left operand, not the whole struct
  // value. That distinction is what lets a direct struct lvalue be the
  // container even though moving the whole value is rejected. `->`, by
  // contrast, consumes a one-word pointer value normally.
  const objectType = expr.arrow
    ? checkValue(expr.object, ctx, live)
    : checkExpr(expr.object, ctx, false, live);
  if (objectType === 'error') return 'error';

  let structType: StructType;
  if (expr.arrow) {
    if (isStruct(objectType)) {
      ctx.diagnostics.push(
        err(
          expr,
          `'->' needs a pointer to a struct, but this is '${typeName(objectType)}' — use '.' to access a member of a struct object`,
        ),
      );
      return 'error';
    }
    const pointee = pointeeOf(objectType);
    if (pointee === null || !isStruct(pointee)) {
      ctx.diagnostics.push(
        err(expr, `'->' needs a pointer to a struct, but this is '${typeName(objectType)}'`),
      );
      return 'error';
    }
    structType = pointee;
  } else {
    const pointee = pointeeOf(objectType);
    if (pointee !== null && isStruct(pointee)) {
      ctx.diagnostics.push(
        err(
          expr,
          `'.' needs a struct object, but this is '${typeName(objectType)}' — use '->' to access a member through a pointer`,
        ),
      );
      return 'error';
    }
    if (!isStruct(objectType)) {
      ctx.diagnostics.push(
        err(expr, `'.' needs a struct object, but this is '${typeName(objectType)}'`),
      );
      return 'error';
    }
    if (!isLvalue(expr.object)) {
      ctx.diagnostics.push(
        err(
          expr,
          "'.' needs a stored struct object on the left — this expression is not an lvalue",
        ),
      );
      return 'error';
    }
    structType = objectType;
  }

  // Pass 1 completes interned StructType objects in place. The source-index
  // guard is therefore essential here: a function body before a later
  // definition must still see the tag as incomplete during pass 2.
  if (incompleteStructAt(structType, ctx.currentDeclIndex, ctx.types) !== null) {
    ctx.diagnostics.push(
      err(
        expr,
        `member access needs the complete definition of '${typeName(structType)}' — define it before this access`,
      ),
    );
    return 'error';
  }

  const member = structType.members.find((candidate) => candidate.name === expr.member);
  if (!member) {
    ctx.diagnostics.push(
      err(expr, `'${typeName(structType)}' has no member named '${expr.member}'`),
    );
    return 'error';
  }

  expr.resolvedType = member.type;
  expr.memberOffset = member.offset;
  return member.type;
}

// Pointer operands. `p + n`, `n + p`, and `p - n` are legal and scale by the
// pointee's word size at codegen. Pointer subtraction and pointer ordering
// are outside the subset. Equality is in — it is what the null-pointer
// idiom needs.
function checkPointerBinary(
  expr: Binary,
  lt: CType | 'error',
  rt: CType | 'error',
  lp: boolean,
  rp: boolean,
  ctx: Ctx,
): CType | 'error' {
  if (lt === 'error' || rt === 'error') return 'error';
  if (expr.op === '==' || expr.op === '!=') {
    const compatible =
      (lp && rp && typesEqual(decay(lt), decay(rt))) ||
      (lp && isNullPointerConstant(expr.right)) ||
      (rp && isNullPointerConstant(expr.left));
    if (!compatible) {
      ctx.diagnostics.push(err(expr, `cannot compare '${typeName(lt)}' with '${typeName(rt)}'`));
      return 'error';
    }
    return 'int';
  }
  if (expr.op === '<' || expr.op === '<=' || expr.op === '>' || expr.op === '>=') {
    ctx.diagnostics.push(err(expr, POINTER_RELATIONAL.message));
    return 'error';
  }
  if (expr.op === '-' && lp && rp) {
    ctx.diagnostics.push(err(expr, POINTER_SUBTRACTION.message));
    return 'error';
  }
  // Stamp the scale factor codegen must apply to the integer operand
  // in emitBinary/emitLeftRightThenCombine; it is never re-derived by
  // codegen itself. `scaleLeft` records which operand is the integer one:
  // `n + p` has it on the left, the ordinary `p + n` / `p - n` shape on the
  // right (the default, so only the `n + p` branch sets it).
  if ((expr.op === '+' || expr.op === '-') && lp && !rp) {
    const pointee = pointeeOf(lt)!;
    if (!requireCompletePointerArithmetic(pointee, expr, ctx)) return 'error';
    expr.pointerScale = sizeInWords(pointee);
    return decay(lt);
  }
  if (expr.op === '+' && rp && !lp) {
    const pointee = pointeeOf(rt)!;
    if (!requireCompletePointerArithmetic(pointee, expr, ctx)) return 'error';
    expr.pointerScale = sizeInWords(pointee);
    expr.scaleLeft = true;
    return decay(rt);
  }
  ctx.diagnostics.push(
    err(expr, `'${expr.op}' cannot be applied to '${typeName(lt)}' and '${typeName(rt)}'`),
  );
  return 'error';
}

// An integer constant expression equal to 0. This is the ONLY int-to-pointer
// conversion the subset permits, and it is what makes NULL work.
function isNullPointerConstant(expr: Expr): boolean {
  return constFoldProbe(expr) === 0;
}

function isExactVoidPointer(type: CType): boolean {
  return isPointer(type) && type.to === 'void';
}

// Unifies a ternary's two arms the same way checkPointerBinary unifies a
// Binary's two operands, so `p = cond ? a : b;` doesn't lose a pointer type
// through the ?: the way it did before this existed (both arms fell back to
// the scalar 'int' unconditionally). Neither arm decays for the comparison
// itself (typesEqual on the raw types would wrongly distinguish an array
// arm from an equivalent pointer arm), only for the RESULT, mirroring
// checkPointerBinary's own `decay(lt)`/`decay(rt)`.
function checkCondResultType(
  expr: Cond,
  t1: CType | 'error',
  t2: CType | 'error',
  ctx: Ctx,
): CType | 'error' {
  if (t1 === 'error' || t2 === 'error') return 'error';
  if (isStruct(t1) || isStruct(t2)) {
    ctx.diagnostics.push(err(expr, STRUCT_SCALAR_VALUE_MESSAGE));
    return 'error';
  }
  const p1 = pointeeOf(t1) !== null;
  const p2 = pointeeOf(t2) !== null;
  if (!p1 && !p2) return 'int'; // every ordinary scalar ?: yields int
  if (p1 && p2 && typesEqual(decay(t1), decay(t2))) return decay(t1);
  if (p1 && !p2 && isNullPointerConstant(expr.else)) return decay(t1);
  if (p2 && !p1 && isNullPointerConstant(expr.then)) return decay(t2);
  ctx.diagnostics.push(
    err(expr, `'?:' has mismatched types '${typeName(t1)}' and '${typeName(t2)}'`),
  );
  return 'error';
}

function checkCall(expr: Call, ctx: Ctx, live: boolean): CType | 'error' {
  const binding = ctx.resolver.resolve(expr.callee, ctx.currentDeclIndex);

  // Resolve the callee BEFORE checking its arguments. frobnicate("a", x)
  // (a made-up name with no signature at all) used to first report the
  // string-literal argument with STRING_LITERAL_CONTEXT's message (legal only
  // as printf's or scanf's format argument, or a char array's initializer) —
  // an error about the wrong thing — before an unresolved callee's own
  // diagnostic ever had a chance to fire. Doing the callee first means the
  // named, actionable message is what the student sees; a genuine argument
  // problem on a real call still surfaces once we have a signature below.
  // Builtins follow the same rule: once their signatures resolve, string-
  // literal arguments are checked through STRING_LITERAL_CONTEXT like
  // arguments to any other callable. Lookup-order handling is needed only
  // for an unresolved or shadowed callee. This separation keeps callee
  // diagnostics independent from argument diagnostics while preserving
  // ordinary signature checks for valid calls.
  // Callability is established before any argument walk begins.

  // A name that resolves to a VARIABLE (a local, parameter, or global
  // shadowing a same-named function or builtin) is not callable.
  // This must run before the printf special case below: a local
  // `int printf` shadows the builtin exactly like it shadows a user
  // function.
  if (binding && binding.kind === 'var') {
    ctx.diagnostics.push(
      err(
        expr,
        `'${expr.callee}' is not a function (it is declared as ${typeName(binding.symbol.type)} here)`,
      ),
    );
    return 'error';
  }

  if (expr.callee === 'printf') return checkPrintfCall(expr, ctx, live);
  if (expr.callee === 'scanf') return checkScanfCall(expr, ctx, live);

  const sig = binding;
  if (!sig) {
    // No visible function of this name. Distinguish three cases: a file-scope
    // function declared LATER in the source (declare-before-use, Ch 14 section
    // 14.2.1.1); a KNOWN unavailable library function (calloc, realloc,
    // puts, gets), which gets its named subset-boundary message from the ONE
    // feature-status table (features.ts); or a truly
    // unknown name. None of these registers the name as callable — this is a
    // diagnostic-wording distinction only.
    let message: string;
    if (ctx.resolver.declaredLater(expr.callee, ctx.currentDeclIndex)) {
      message = `'${expr.callee}' is used before its declaration`;
    } else {
      const libraryFeature = LIBRARY_FUNCTION_FEATURES[expr.callee];
      message = libraryFeature
        ? libraryFeature.message
        : `call to undeclared function '${expr.callee}'`;
    }
    ctx.diagnostics.push(err(expr, message));
    return 'error';
  }

  const argTypes = expr.args.map((a) => checkArgumentValue(a, ctx, live));

  // Single-translation-unit model: there is no linker, so a user function
  // that is declared (a prototype) but never given a body in this program
  // can never be satisfied — codegen would emit a JSR to an F_<name> label
  // that no emitFunction ever defines, and the assembler would reject the
  // undefined symbol with a raw error the student never asked for. Reject
  // the call here instead. Builtins (putchar/getchar/printf/scanf/strcmp/
  // strcpy/malloc/free) are provided by the runtime library and are legal to call with
  // no user body.
  if (!sig.isBuiltin && !sig.hasBody) {
    ctx.diagnostics.push(
      err(
        expr,
        `'${expr.callee}' is declared but never defined — this compiler builds a single file, so every function you call needs a body here`,
      ),
    );
    return sig.returnType;
  }

  if (argTypes.length !== sig.params.length) {
    ctx.diagnostics.push(
      err(
        expr,
        `function '${expr.callee}' expects ${sig.params.length} argument(s) but got ${argTypes.length}`,
      ),
    );
    return sig.returnType;
  }

  sig.params.forEach((paramType, i) => {
    const argType = argTypes[i];
    if (
      argType !== 'error' &&
      !checkAssignableConversion(argType, paramType, expr.args[i], ctx.diagnostics)
    ) {
      ctx.diagnostics.push(
        err(
          expr.args[i],
          `argument ${i + 1} to '${expr.callee}' has an incompatible type ('${typeName(argType)}' vs. expected '${typeName(paramType)}')`,
        ),
      );
    }
  });

  return sig.returnType;
}

// `fromExpr`, when given, is the actual expression being assigned/passed —
// needed only to decide whether an int-typed `from` is the integer constant
// 0 (the ONE int-to-pointer conversion the subset permits, and what makes
// NULL work). Callers pass it whenever a source expression is available;
// omitting it means a scalar cannot satisfy a pointer target through that
// call site, which is conservative rather than unsound.
// Every pointer-permitting declared-type boundary provides the expression.
function isAssignable(from: CType, to: CType, fromExpr?: Expr): boolean {
  if (from === 'void' || to === 'void') return false;
  if (isScalar(from) && isScalar(to)) return true; // int/char/bool interconvert
  const toP = isPointer(to) ? to : null;
  if (toP) {
    if (isScalar(from)) return fromExpr !== undefined && isNullPointerConstant(fromExpr);
    const fromP = decay(from);
    if (!isPointer(fromP)) return false;
    // The only widened pointer conversions: any object pointer may enter the
    // internal malloc/free void * boundary, and that exact internal type may
    // leave it for a non-void pointer target. The latter's warning is owned by
    // checkAssignableConversion below; an explicit Cast never calls it.
    if (isExactVoidPointer(toP) || isExactVoidPointer(fromP)) return true;
    return typesEqual(fromP, toP);
  }
  return false;
}

// One conversion join for all five ordinary declared-type boundaries. Keeping
// the warning here makes global/local initializer, assignment, return, and call
// argument behavior identical while leaving isAssignable itself a pure
// predicate.
function checkAssignableConversion(
  from: CType,
  to: CType,
  fromExpr: Expr,
  diagnostics: CcDiagnostic[],
): boolean {
  if (!isAssignable(from, to, fromExpr)) return false;
  if (isExactVoidPointer(from) && isPointer(to) && !isExactVoidPointer(to)) {
    diagnostics.push(
      warn(
        fromExpr,
        `malloc returns 'void *'; converting it to '${typeName(to)}' without a cast — write an explicit '(${typeName(to)})' cast`,
      ),
    );
  }
  return true;
}

const PRINTF_OK_CONVERSIONS = new Set(['d', 'c', 'x', 'b', 's']);

function checkPrintfCall(expr: Call, ctx: Ctx, live: boolean): CType {
  const fmt = expr.args[0];
  if (!fmt || fmt.kind !== 'StrLit') {
    ctx.diagnostics.push(
      err(expr, "printf's first argument must be a string literal format string"),
    );
    for (const a of expr.args) checkArgumentValue(a, ctx, live);
    return 'int';
  }

  const { specs, hadError } = checkPrintfFormat(fmt, ctx);
  const argTypes = expr.args.slice(1).map((a) => checkArgumentValue(a, ctx, live));

  // A format the scanner rejected (unsupported/unrecognized specifier, dangling
  // '%') consumes an indeterminate number of arguments, so the conversion count
  // is meaningless — a mismatch warning on top of the real error would be a
  // second, contradictory diagnostic. Suppress it, and skip the
  // per-conversion argument-type check below for the same reason.
  const givenArgCount = argTypes.length;
  if (!hadError && specs.length !== givenArgCount) {
    ctx.diagnostics.push(
      warn(
        expr,
        `printf format string has ${specs.length} conversion(s) but ${givenArgCount} argument(s) were given`,
      ),
    );
  }

  // %s's argument must be a char pointer after decay (a char array or a
  // char* value) — every other conversion in this subset accepts any scalar
  // by design, so %s is
  // the one conversion checked here rather than left to the runtime.
  // Skipped entirely when the format itself already errored, and skipped
  // per-argument when the count mismatch above means there is no
  // corresponding argument to check.
  if (!hadError) {
    specs.forEach((spec, i) => {
      if (spec !== 's') return;
      const argType = argTypes[i];
      if (argType === undefined || argType === 'error') return;
      if (!typesEqual(decay(argType), ptr('char'))) {
        ctx.diagnostics.push(
          err(
            expr.args[i + 1],
            `printf's '%s' argument must be 'char *' but got '${typeName(argType)}'`,
          ),
        );
      }
    });
  }

  return 'int';
}

// Validates the supported conversion set (%d %c %x %b %s %%) and returns, in format
// order, the specifier characters that consume an argument (%% does not)
// plus whether any specifier was rejected. Stops at the first NUL: the lexer
// makes a real NUL for `\0`, and both .STRINGZ storage and the runtime
// RTPF_LOOP (runtime.ts) stop there, so everything after it is dead — the
// checker must agree with the machine.
function checkPrintfFormat(
  fmt: { value: string; line: number; col: number },
  ctx: Ctx,
): { specs: string[]; hadError: boolean } {
  const nul = fmt.value.indexOf('\u0000');
  const text = nul === -1 ? fmt.value : fmt.value.slice(0, nul);
  const specs: string[] = [];
  let hadError = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '%') continue;
    const spec = text[i + 1];
    i++;
    if (spec === '%') continue;
    if (spec === undefined) {
      ctx.diagnostics.push(err(fmt, "printf format string ends with a dangling '%'"));
      hadError = true;
      break;
    }
    if (PRINTF_OK_CONVERSIONS.has(spec)) {
      specs.push(spec);
      continue;
    }
    if (spec === 'f') {
      ctx.diagnostics.push(err(fmt, FLOAT_CONVERSION.message));
      hadError = true;
      continue;
    }
    ctx.diagnostics.push(err(fmt, `printf format specifier '%${spec}' is not recognized`));
    hadError = true;
  }
  return { specs, hadError };
}

// Every argument-consuming conversion this checker supports writes through a
// pointer to a value of this type — %d needs 'int *', %c needs 'char *', and
// %s needs 'char *' too (its argument is a char array or char pointer, exactly
// mirroring printf's own %s rule). This table is the single source for
// which conversions F_scanf (runtime.ts) implements;
// SCANF_OK_CONVERSIONS below is derived from its
// keys rather than hand-listed a second time, so the two can never drift
// apart the way two independently maintained lists could (`strict` is on
// but `noUncheckedIndexedAccess` is not, so a drift would silently build
// `ptr(undefined)` rather than fail to compile). %% is handled separately by
// checkScanfFormat because it matches a literal percent and consumes no
// argument. These entries state only the accepted conversion contract and
// describe what this compiler's scanf accepts now, mirroring printf's own
// '%f'/unrecognized-specifier wording style.
const SCANF_POINTEE_TYPE: Readonly<Record<string, CType>> = { d: 'int', c: 'char', s: 'char' };
const SCANF_OK_CONVERSIONS = new Set(Object.keys(SCANF_POINTEE_TYPE));

// printf's own conversions (PRINTF_OK_CONVERSIONS) with no scanf
// counterpart in this compiler — %x and %b really are printf conversions
// here; %i/%o/%u are not printf conversions either, but are named alongside
// them since a student reaching for hex/octal/unsigned might try any of the
// five. See SCANF_UNSUPPORTED_CONVERSION (features.ts) for why this is a
// permanent exclusion in the supported scanf contract.
const SCANF_UNSUPPORTED_CONVERSIONS = new Set(['x', 'b', 'i', 'o', 'u']);

function checkScanfCall(expr: Call, ctx: Ctx, live: boolean): CType {
  const fmt = expr.args[0];
  if (!fmt || fmt.kind !== 'StrLit') {
    ctx.diagnostics.push(
      err(expr, "scanf's first argument must be a string literal format string"),
    );
    for (const a of expr.args) checkArgumentValue(a, ctx, live);
    return 'int';
  }

  const { specs, hadError } = checkScanfFormat(fmt, ctx);
  const argTypes = expr.args.slice(1).map((a) => checkArgumentValue(a, ctx, live));

  // A format the scanner rejected consumes an indeterminate number of
  // arguments, so the conversion count is meaningless here too (this
  // mirrors checkPrintfCall's identical guard).
  const givenArgCount = argTypes.length;
  if (!hadError && specs.length !== givenArgCount) {
    ctx.diagnostics.push(
      warn(
        expr,
        `scanf format string has ${specs.length} conversion(s) but ${givenArgCount} argument(s) were given`,
      ),
    );
  }

  // Every scanf destination must be a pointer to the conversion's
  // own type (SCANF_POINTEE_TYPE). Three outcomes, distinguished by what the
  // argument's type (after array decay) actually is: a pointer to the RIGHT
  // pointee (or an array that decays to one) is clean, no diagnostic; a
  // pointer to the WRONG pointee (e.g. char * given to %d) gets an ordinary
  // type error using the same wording as the %s check; a non-pointer scalar
  // (the student forgot '&') is a WARNING, not an error — the same treatment
  // `if (x =
  // 2)` already gets above: legal C, a named pitfall, warn and let it run.
  // Whether it faults with an ACV or silently corrupts memory depends on the
  // garbage the argument holds, which is exactly why the warning, not
  // silence, is required.
  // Skipped entirely when the format itself already errored, and skipped
  // per-argument when the count mismatch above means there is no
  // corresponding argument to check.
  if (!hadError) {
    specs.forEach((spec, i) => {
      const argType = argTypes[i];
      if (argType === undefined || argType === 'error') return;
      const expected = ptr(SCANF_POINTEE_TYPE[spec]);
      const decayed = decay(argType);
      if (isPointer(decayed)) {
        if (typesEqual(decayed, expected)) return;
        // &arr, when arr is an array whose OWN decay is the expected type
        // (e.g. &w for `char w[8]` passed to %s), is a pointer to the
        // array, not to its first element — the '&' was unneeded rather
        // than wrong in spirit, so this one wrong-pointee shape gets a hint
        // the others don't.
        const pointee = decayed.to;
        const hint =
          isArray(pointee) && typesEqual(decay(pointee), expected)
            ? ` — pass the array itself, not its address; it already decays to '${typeName(expected)}'`
            : '';
        ctx.diagnostics.push(
          err(
            expr.args[i + 1],
            `scanf's '%${spec}' argument must be '${typeName(expected)}' but got '${typeName(argType)}'${hint}`,
          ),
        );
        return;
      }
      // The '&' hint is only offered when taking this argument's address
      // would actually produce the expected type — typesEqual(ptr(argType),
      // expected). `int x; scanf("%s", x);` fails that test (&x is 'int *',
      // still not 'char *'), so the hint would mislead there; withheld, the
      // message states only what is true.
      const hint = typesEqual(ptr(argType), expected) ? ` — did you forget '&'?` : '';
      ctx.diagnostics.push(
        warn(
          expr.args[i + 1],
          `scanf's '%${spec}' argument should be '${typeName(expected)}'${hint} (got '${typeName(argType)}')`,
        ),
      );
    });
  }

  return 'int';
}

// Stops at the first NUL, same reasoning as checkPrintfFormat (the lexer
// makes a real NUL for `\0`, and F_scanf's own dispatch loop stops there
// too — the checker must agree with the machine). Literal characters,
// including whitespace, are accepted rather than rejected:
// F_scanf's RTSC_LITERAL/RTSC_SKIPWS handle them at runtime, so the checker's
// responsibility for a non-'%' character is simply to leave it alone,
// matching how checkPrintfFormat treats printf's literal text.
// This keeps static validation aligned with the runtime dispatch loop.
function checkScanfFormat(
  fmt: { value: string; line: number; col: number },
  ctx: Ctx,
): { specs: string[]; hadError: boolean } {
  const nul = fmt.value.indexOf('\u0000');
  const text = nul === -1 ? fmt.value : fmt.value.slice(0, nul);
  const specs: string[] = [];
  let hadError = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '%') continue;
    const spec = text[i + 1];
    i++;
    if (spec === '%') continue;
    if (spec === undefined) {
      ctx.diagnostics.push(err(fmt, "scanf format string ends with a dangling '%'"));
      hadError = true;
      break;
    }
    if (SCANF_OK_CONVERSIONS.has(spec)) {
      specs.push(spec);
      continue;
    }
    if (spec === 'f') {
      ctx.diagnostics.push(err(fmt, FLOAT_CONVERSION.message));
      hadError = true;
      continue;
    }
    if (SCANF_UNSUPPORTED_CONVERSIONS.has(spec)) {
      ctx.diagnostics.push(err(fmt, SCANF_UNSUPPORTED_CONVERSION.message));
      hadError = true;
      continue;
    }
    ctx.diagnostics.push(err(fmt, `scanf format specifier '%${spec}' is not recognized`));
    hadError = true;
  }
  return { specs, hadError };
}

// The one "a value is required here" gate. Type-checks `expr`, and if it is
// a void-typed expression (in this subset only a call to a void-returning
// function can be), reports a named error identifying the culprit and
// returns 'error'. Every context that consumes a value routes through here,
// so a void expression is rejected uniformly: variable initializers,
// assignment RHS, arithmetic/logical/comparison operands, if/while/for/do
// conditions, a non-void `return`, ternary operands, and call arguments. A
// bare `f();` statement (checkStmt's ExprStmt path) deliberately does NOT,
// so calling a void function purely for its effect stays legal.
function checkValue(expr: Expr, ctx: Ctx, live = true): CType | 'error' {
  const t = checkExpr(expr, ctx, false, live);
  if (t === 'void') {
    ctx.diagnostics.push(
      err(
        expr,
        expr.kind === 'Call'
          ? `'${expr.callee}' returns nothing (void) but a value is needed here`
          : 'this expression has no value (void) but a value is needed here',
      ),
    );
    return 'error';
  }
  return t;
}

// Probe a subexpression's constant value WITHOUT emitting any diagnostics (a
// throwaway sink) and WITH the runtime div-by-zero VALUE error suppressed —
// this is a pure query, never a report. Callers use it to mirror
// foldConstExpr reachability exactly: deciding whether a &&/||/?: branch is
// statically dead, whether a `/` or `%` divisor is a compile-time constant 0,
// and whether a subscript's index is a compile-time constant, so
// codegen's folded-offset form can never disagree with this pass about what
// folds. The operands are ALSO checked through the normal checkExpr path,
// which owns every static diagnostic (undeclared name, string literal,
// ++/--), so nothing this probe discards is a lost report. Exported for
// codegen.ts's constFoldIndex.
export function constFoldProbe(expr: Expr): number | null {
  return foldConstExpr(expr, [], '', true);
}

// A `&&`/`||` right operand is statically dead exactly when the left operand
// folds to a constant that short-circuits it — the same condition
// foldConstExpr uses for its lazy fold (check.ts's Binary case), so the
// checker's reachability agrees with the constant folder bit-for-bit.
function shortCircuits(op: '&&' | '||', left: Expr): boolean {
  const l = constFoldProbe(left);
  if (l === null) return false;
  return (op === '&&' && l === 0) || (op === '||' && l !== 0);
}

// `live` tracks static reachability: false once we descend into a branch a
// short-circuit (&&/||) or a constant ?: condition proves is never evaluated
// at runtime. Both branches are still RECURSED INTO for type checking, but the
// constant-zero-divisor diagnostic is gated on `live` so it never
// false-positives on a provably-unevaluated division — mirroring foldConstExpr's
// suppressValueError. External callers start live=true.
function checkExpr(expr: Expr, ctx: Ctx, allowStrLit: boolean, live = true): CType | 'error' {
  switch (expr.kind) {
    case 'IntLit':
      return 'int';
    case 'SizeofType':
      return resolveSizeofType(expr, ctx.diagnostics, ctx.types, ctx.currentDeclIndex)
        ? 'int'
        : 'error';
    case 'Cast':
      return checkCast(expr, ctx, live);
    case 'StrLit':
      if (!allowStrLit) {
        ctx.diagnostics.push(err(expr, STRING_LITERAL_CONTEXT.message));
        return 'error';
      }
      return 'int';
    case 'Ident':
      return checkIdentUse(expr, ctx);
    case 'Unary':
      return checkUnary(expr, ctx, live);
    case 'Binary': {
      if (expr.op === '&&' || expr.op === '||') {
        const lt = checkValue(expr.left, ctx, live);
        const rt = checkValue(expr.right, ctx, live && !shortCircuits(expr.op, expr.left));
        if ((lt !== 'error' && isStruct(lt)) || (rt !== 'error' && isStruct(rt))) {
          ctx.diagnostics.push(err(expr, structOperatorMessage(expr.op)));
          return 'error';
        }
        return 'int';
      }
      const lt = checkValue(expr.left, ctx, live);
      const rt = checkValue(expr.right, ctx, live);
      if ((lt !== 'error' && isStruct(lt)) || (rt !== 'error' && isStruct(rt))) {
        ctx.diagnostics.push(err(expr, structOperatorMessage(expr.op)));
        return 'error';
      }
      const lp = lt !== 'error' && pointeeOf(lt) !== null;
      const rp = rt !== 'error' && pointeeOf(rt) !== null;
      if (lp || rp) {
        return checkPointerBinary(expr, lt, rt, lp, rp, ctx);
      }
      // A divisor that const-folds to exactly 0, in a position the
      // program actually evaluates, is a compile-time error — the runtime
      // division lowering (the RTDIV/RTMOD call) would loop until the run
      // budget is exhausted. A variable divisor folds to null, never 0, so it
      // is left
      // to the runtime notice. In a constant context foldConstExpr already
      // reports this, and it never routes through here, so there is no double
      // report.
      if (live && (expr.op === '/' || expr.op === '%') && constFoldProbe(expr.right) === 0) {
        ctx.diagnostics.push(err(expr, 'division by zero — the divisor is always 0'));
      }
      // A shift whose count operand const-folds outside 0..15 is a
      // compile error in every runtime position too (a const context routes
      // through foldConstExpr, which reports it there; constFoldProbe suppresses
      // it, so this is the only report). A variable count folds to null and is
      // left to the documented runtime loop.
      if (live && (expr.op === '<<' || expr.op === '>>')) {
        const count = constFoldProbe(expr.right);
        if (count !== null && !isShiftCountInRange(count)) {
          ctx.diagnostics.push(shiftCountError(expr, count));
        }
      }
      return 'int';
    }
    case 'Assign':
      return checkAssign(expr, ctx, live);
    case 'Call':
      return checkCall(expr, ctx, live);
    case 'Cond': {
      const condType = checkValue(expr.cond, ctx, live);
      if (condType !== 'error' && isStruct(condType)) {
        ctx.diagnostics.push(err(expr.cond, STRUCT_CONDITION_MESSAGE));
      }
      // A constant condition makes the untaken arm statically dead; a
      // non-constant one (null) leaves both arms live — matching foldConstExpr's
      // ?: reachability.
      const c = constFoldProbe(expr.cond);
      const t1 = checkValue(expr.then, ctx, live && (c === null || c !== 0));
      const t2 = checkValue(expr.else, ctx, live && (c === null || c === 0));
      return checkCondResultType(expr, t1, t2, ctx);
    }
    case 'Subscript':
      return checkSubscript(expr, ctx, live);
    case 'Member':
      return checkMember(expr, ctx, live);
    case 'Deref':
      return checkDeref(expr, ctx, live);
    case 'AddrOf':
      return checkAddrOf(expr, ctx, live);
  }
}

// AST node shapes for the supported C subset. Every node carries the
// position (line/col) of its first token, so a downstream caller can always
// point a diagnostic at it.
// CType includes scalar, pointer, array, and struct composites. Expressions
// include subscripting, dereferencing, address-of, member access, sizeof over
// a type name, and the narrow cast form accepted for naming a dynamically
// allocated pointer result.

import type { VarSymbol } from './symbols.js';

export interface Node {
  line: number;
  col: number;
}

// CType is deliberately HYBRID rather than a uniform discriminated union: its
// four scalars keep their bare-string spelling, while composite types use
// objects. That keeps `t === 'bool'` tests in check.ts and codegen.ts direct
// and preserves the scalar shape in symbol-table snapshots. `typeof t ===
// 'string'` is the scalar test; pointers, arrays, and structs are narrowed by
// their `kind` field. This keeps scalar-heavy code simple without sacrificing
// explicit structure for aggregate types.
export type ScalarType = 'int' | 'char' | 'bool' | 'void';

export interface PointerType {
  kind: 'pointer';
  to: CType;
}

// A 2D array is an array of arrays: `int a[3][4]` is
// arr(arr('int', 4), 3). Row-major addressing then needs no special case
// anywhere — it is subscripting applied twice, and the row stride is just
// sizeInWords of the element type.
export interface ArrayType {
  kind: 'array';
  of: CType;
  length: number;
}

export interface StructMember {
  name: string;
  type: CType;
  offset: number;
}

export interface StructType {
  kind: 'struct';
  tag: string;
  members: StructMember[];
  sizeWords: number;
  complete: boolean;
}

export type CType = ScalarType | PointerType | ArrayType | StructType;

export function ptr(to: CType): PointerType {
  return { kind: 'pointer', to };
}

export function arr(of: CType, length: number): ArrayType {
  return { kind: 'array', of, length };
}

export function isScalar(t: CType): t is ScalarType {
  return typeof t === 'string';
}

export function isPointer(t: CType): t is PointerType {
  return typeof t === 'object' && t.kind === 'pointer';
}

export function isArray(t: CType): t is ArrayType {
  return typeof t === 'object' && t.kind === 'array';
}

export function isStruct(t: CType): t is StructType {
  return typeof t === 'object' && t.kind === 'struct';
}

function unexpectedCType(t: never): never {
  throw new Error(`ast: unexpected CType variant '${String(t)}'`);
}

// The ONE place word sizing is decided. Every scalar and every pointer is a
// single 16-bit location; an array is its length times its
// element size, and a complete struct carries its checker-computed layout.
export function sizeInWords(t: CType): number {
  if (isScalar(t)) return 1;
  switch (t.kind) {
    case 'pointer':
      return 1;
    case 'array':
      return t.length * sizeInWords(t.of);
    case 'struct':
      if (!t.complete) {
        throw new Error(`ast: cannot size incomplete struct '${t.tag}'`);
      }
      return t.sizeWords;
    default:
      return unexpectedCType(t);
  }
}

// C's array-to-pointer adjustment: an array used as a value becomes a
// pointer to its first element (book 16.3.5). Everything else is itself.
export function decay(t: CType): CType {
  if (isScalar(t)) return t;
  switch (t.kind) {
    case 'pointer':
    case 'struct':
      return t;
    case 'array':
      return ptr(t.of);
    default:
      return unexpectedCType(t);
  }
}

// The pointee after decay, or null when `t` is not indirectable. This is
// what makes `a[i]` and `*p` share one rule.
export function pointeeOf(t: CType): CType | null {
  if (isScalar(t)) return null;
  switch (t.kind) {
    case 'pointer':
      return t.to;
    case 'array':
      return t.of;
    case 'struct':
      return null;
    default:
      return unexpectedCType(t);
  }
}

export function typesEqual(a: CType, b: CType): boolean {
  if (isScalar(a)) return isScalar(b) && a === b;
  if (isScalar(b)) return false;
  switch (a.kind) {
    case 'pointer':
      return isPointer(b) && typesEqual(a.to, b.to);
    case 'array':
      return isArray(b) && a.length === b.length && typesEqual(a.of, b.of);
    case 'struct':
      return isStruct(b) && a.tag === b.tag;
    default:
      return unexpectedCType(a);
  }
}

// Diagnostic rendering. Array dimensions read outermost-first the way C
// declares them (`int [3][4]`), and a pointer to an array takes the
// parenthesized form (`int (*)[4]`) so it can never be misread as an array
// of pointers, which this subset does not have.
export function typeName(t: CType): string {
  if (isScalar(t)) return t;
  switch (t.kind) {
    case 'array': {
      const dims: number[] = [];
      let cur: CType = t;
      while (isArray(cur)) {
        dims.push(cur.length);
        cur = cur.of;
      }
      return `${typeName(cur)} ${dims.map((d) => `[${d}]`).join('')}`;
    }
    case 'pointer':
      if (isArray(t.to)) return `${typeName(t.to).replace(/ \[/, ' (*)[')}`;
      return isPointer(t.to) ? `${typeName(t.to)}*` : `${typeName(t.to)} *`;
    case 'struct':
      return `struct ${t.tag}`;
    default:
      return unexpectedCType(t);
  }
}

// The SYNTACTIC form of a declared type or abstract type name, as written.
// The parser builds this; check.ts folds the dimension expressions and
// resolves it into a semantic CType. A null entry in `dims` is an unspecified
// `[]`, legal only as the leading dimension of a parameter. Keeping syntax
// separate from semantic types lets the checker evaluate dimensions with the
// correct source-order environment.
export type BaseSpec = ScalarType | { struct: string } | { typedefName: string };

export interface TypeSpec {
  base: BaseSpec;
  pointerDepth: number;
  dims: (Expr | null)[];
}

export interface StructMemberDecl extends Node {
  kind: 'StructMemberDecl';
  name: string;
  typeSpec: TypeSpec;
}

export interface StructDecl extends Node {
  kind: 'StructDecl';
  tag: string;
  members: StructMemberDecl[];
}

export interface TypedefDecl extends Node {
  kind: 'TypedefDecl';
  name: string;
  typeSpec: TypeSpec;
}

export type TopLevelDecl = VarDecl | FuncDecl | StructDecl | TypedefDecl;

export interface Program extends Node {
  kind: 'Program';
  decls: TopLevelDecl[];
}

export interface VarDecl extends Node {
  kind: 'VarDecl';
  name: string;
  typeSpec: TypeSpec;
  init?: Expr;
  isConst: boolean;
  // The symbol this declaration binds, stamped by check.ts's resolver
  // (scopes.ts) and read by codegen for local/for-init declarations so both
  // passes use the exact same slot. Unset for global declarations
  // (codegen lays those out from SymbolTables directly).
  resolved?: VarSymbol;
  // The semantic type this declaration's TypeSpec folds to, stamped by
  // check.ts so codegen never re-folds a dimension expression.
  resolvedType?: CType;
}

export interface Param extends Node {
  kind: 'Param';
  name: string | null;
  typeSpec: TypeSpec;
  resolvedType?: CType;
}

export interface FuncDecl extends Node {
  kind: 'FuncDecl';
  name: string;
  returnSpec: TypeSpec;
  resolvedReturnType?: CType;
  params: Param[];
  body?: Block;
}

export type Stmt =
  Block | If | While | DoWhile | For | Switch | Return | Break | Continue | ExprStmt | VarDecl;

export interface Block extends Node {
  kind: 'Block';
  stmts: Stmt[];
  // Line of the closing '}' (or, for the synthetic single-statement-slot
  // wrapper parser.ts builds around a declarator list, the last
  // declarator's line — that wrapper has no real brace and is never a
  // function body). Codegen needs this for the implicit epilogue's
  // lineMap entry (the closing-brace line, per the calling-convention's
  // lineMap contract) when control falls off the end of a function without
  // an explicit return.
  endLine: number;
}

export interface If extends Node {
  kind: 'If';
  cond: Expr;
  then: Stmt;
  else: Stmt | null;
}

export interface While extends Node {
  kind: 'While';
  cond: Expr;
  body: Stmt;
}

export interface DoWhile extends Node {
  kind: 'DoWhile';
  cond: Expr;
  body: Stmt;
}

// A declaration init is scoped to the loop. A declaration for-init is always
// a VarDecl list (one entry for `for (int i = 0; ...)`, several for the C99
// comma form `for (int i = 0, j = 3; ...)`); an expression
// init stays a single Expr.
export interface For extends Node {
  kind: 'For';
  init: Expr | VarDecl[] | null;
  cond: Expr | null;
  update: Expr | null;
  body: Stmt;
}

// One row of a switch body. `value` is null exactly for the default row
// (Switch.defaultIndex names which entry of `cases` that is). Keeping null in
// this slot makes the default row explicit without inventing an expression.
export interface SwitchCase extends Node {
  kind: 'SwitchCase';
  value: Expr | null;
  stmts: Stmt[];
}

// Fall-through is the natural encoding: a case's stmts run into the next
// case's stmts at runtime unless a Break stmt appears — codegen's concern,
// not a shape the AST needs to represent explicitly.
//
// Checker contract: duplicate `default:` labels are not
// rejected by the parser. `defaultIndex` names only the FIRST `default:`
// row; every `default:` the source writes still gets its own entry in
// `cases[]` (value: null). The checker must scan `cases[]` itself to spot
// a second `default:` and diagnose the duplicate — `defaultIndex` alone
// can't tell you one exists.
export interface Switch extends Node {
  kind: 'Switch';
  expr: Expr;
  cases: SwitchCase[];
  defaultIndex: number | null;
}

export interface Return extends Node {
  kind: 'Return';
  expr?: Expr;
}

export interface Break extends Node {
  kind: 'Break';
}

export interface Continue extends Node {
  kind: 'Continue';
}

// expr is null for the empty statement (a bare ';'). Empty statements are
// valid C syntax and must parse without an error.
export interface ExprStmt extends Node {
  kind: 'ExprStmt';
  expr: Expr | null;
}

export type Expr =
  | IntLit
  | StrLit
  | SizeofType
  | Cast
  | Ident
  | Unary
  | Binary
  | Assign
  | Call
  | Cond
  | Subscript
  | Member
  | Deref
  | AddrOf;

export interface IntLit extends Node {
  kind: 'IntLit';
  value: number;
}

export interface StrLit extends Node {
  kind: 'StrLit';
  value: string;
}

// This subset accepts only sizeof with a parenthesized type name. The checker
// resolves the syntax at its source declaration index and stamps the byte
// value once; folding and codegen consume that fact without resolving types
// independently.
export interface SizeofType extends Node {
  kind: 'SizeofType';
  spec: TypeSpec;
  resolvedValue?: number | null;
}

// The only cast form names the non-void pointer type of a void * result.
// The checker owns that narrow semantic boundary; the parser records the
// written target TypeSpec and codegen emits expr unchanged.
export interface Cast extends Node {
  kind: 'Cast';
  spec: TypeSpec;
  expr: Expr;
}

export interface Ident extends Node {
  kind: 'Ident';
  name: string;
  // The variable this occurrence resolves to, stamped by check.ts's resolver
  // (scopes.ts) and read by codegen — never a second lookup. Unset
  // when the occurrence does not resolve to a variable (a diagnostic is
  // produced instead, so codegen never runs on it).
  resolved?: VarSymbol;
}

export type UnaryOp = '-' | '!' | '~' | '++' | '--';

// ++/-- carry fix; -, !, ~ are always fix: 'none'. Postfix's yield-old-value
// semantics is a codegen contract; this node only records shape.
export interface Unary extends Node {
  kind: 'Unary';
  op: UnaryOp;
  expr: Expr;
  fix: 'pre' | 'post' | 'none';
}

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '&'
  | '|'
  | '^'
  | '<<'
  | '>>'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!='
  | '&&'
  | '||';

export interface Binary extends Node {
  kind: 'Binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
  // Stamped by check.ts's checkPointerBinary when this operator is pointer
  // arithmetic (`p + n`, `n + p`, `p - n`): the scale factor
  // (sizeInWords(pointee)) codegen must apply to the INTEGER operand before
  // combining — see emitBinary/emitLeftRightThenCombine. `scaleLeft`
  // distinguishes which operand that is: true for `n + p` (the integer is on
  // the left, the pointer on the right), omitted for the ordinary `p + n` /
  // `p - n` shape (the integer is on the right). Both are undefined when
  // this Binary is not pointer arithmetic — codegen reads this rather than
  // re-deriving pointer-ness of an arbitrary subexpression itself.
  pointerScale?: number;
  scaleLeft?: boolean;
}

export type AssignOp = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '&=' | '|=' | '^=' | '<<=' | '>>=';

export interface Assign extends Node {
  kind: 'Assign';
  op: AssignOp;
  target: Expr;
  value: Expr;
  // Stamped by check.ts's checkAssign when `op` is `+=`/`-=` and the target
  // is pointer-typed: the scale factor (sizeInWords(pointee)) codegen must
  // apply to the value operand before combining — mirrors
  // Binary.pointerScale (checkPointerBinary), needed separately because
  // compound assignment is not a Binary node and so never reaches that
  // stamp on its own. Undefined for every other assignment (plain `=`, or a
  // compound op whose target isn't a pointer).
  pointerScale?: number;
}

// callee is the function name, not a nested Expr: the subset has no
// function pointers, so a call's target is always a
// plain identifier — encoding that in the type avoids every consumer
// re-deriving it from an Ident node.
export interface Call extends Node {
  kind: 'Call';
  callee: string;
  args: Expr[];
}

export interface Cond extends Node {
  kind: 'Cond';
  cond: Expr;
  then: Expr;
  else: Expr;
}

// Distinct node kinds rather than new UnaryOp values: emitAddress switches
// on `kind` with a runtime `default: throw` for every non-lvalue kind, not
// compile-time exhaustiveness — that would need narrowing the parameter to
// an `Lvalue = Ident | Deref | Subscript | Member` sub-union with type guards
// at each call site, a bigger change than this warrants and correctly not
// attempted.
// Folding `*` and `&` into Unary would make every lvalue site test
// `kind === 'Unary' && op === '*'`, which is the shape that invites a
// missed case.
export interface Subscript extends Node {
  kind: 'Subscript';
  array: Expr;
  index: Expr;
  // The element type this subscript resolves to, stamped by check.ts's
  // checkSubscript exactly as checkIdentUse stamps Ident.resolved — codegen
  // reads this through lvalueTypeOf and never re-derives a type itself.
  resolvedType?: CType;
}

export interface Member extends Node {
  kind: 'Member';
  object: Expr;
  member: string;
  arrow: boolean;
  // The checker resolves both facts once. Codegen consumes these stamps and
  // never repeats member lookup or layout arithmetic independently.
  resolvedType?: CType;
  memberOffset?: number;
}

export interface Deref extends Node {
  kind: 'Deref';
  expr: Expr;
  // The pointee type this dereference resolves to, stamped by check.ts's
  // checkDeref exactly as checkIdentUse stamps Ident.resolved — codegen
  // reads this through lvalueTypeOf and never re-derives a type itself.
  resolvedType?: CType;
}

export interface AddrOf extends Node {
  kind: 'AddrOf';
  expr: Expr;
}

// The whole pipeline is exported intentionally, not only compileC and
// CLineMapEntry. Callers can drive the compiler stage by stage — lex, parse,
// check, and codegen, each with its own types — for teaching, diagnostics, or
// exploratory tooling. These entry points are a deliberate public API, not an
// accidental exposure of internals, so compatibility changes require the same
// care as changes to compileC.

export { lex } from './lexer.js';
export type { Token, TokenKind } from './tokens.js';
export { KEYWORDS, SUPPORTED_KEYWORDS, REJECTED_KEYWORDS, PUNCTUATORS } from './tokens.js';
export type { CcDiagnostic } from './diagnostics.js';
export { parse } from './parser.js';
export { check } from './check.js';
export type { Storage, VarSymbol, FuncFrame, SymbolTables } from './symbols.js';
export { localWordCount } from './symbols.js';
export { codegen } from './codegen.js';
export type { CLineMapEntry, CodegenResult } from './codegen.js';
export { compileC } from './compile.js';
export type { CcResult } from './compile.js';
export type {
  Node,
  ScalarType,
  PointerType,
  ArrayType,
  StructMember,
  StructType,
  CType,
  BaseSpec,
  TypeSpec,
  StructMemberDecl,
  StructDecl,
  TypedefDecl,
  TopLevelDecl,
  Program,
  VarDecl,
  Param,
  FuncDecl,
  Stmt,
  Block,
  If,
  While,
  DoWhile,
  For,
  SwitchCase,
  Switch,
  Return,
  Break,
  Continue,
  ExprStmt,
  Expr,
  IntLit,
  StrLit,
  SizeofType,
  Cast,
  Ident,
  UnaryOp,
  Unary,
  BinaryOp,
  Binary,
  AssignOp,
  Assign,
  Call,
  Cond,
  Subscript,
  Member,
  Deref,
  AddrOf,
} from './ast.js';
// CType is a hybrid union (ast.ts's own header explains why): these are
// the only correct way to build or narrow one, so a consumer of the CType
// composites above needs them too, not just the type declarations.
export {
  ptr,
  arr,
  isScalar,
  isPointer,
  isArray,
  isStruct,
  sizeInWords,
  decay,
  pointeeOf,
  typesEqual,
  typeName,
} from './ast.js';
// Runtime frame descriptors form the public stack-frame metadata surface.
// runtimeFrames() maps every externally visible runtime entry label
// (F_putchar through F_free, RTMUL, RTDIV, RTMOD) to its frame layout, so
// consumers can render a named frame for any callee with a descriptor --
// stepping into printf, or into the * operator's RTMUL, shows the same
// frame discipline as any compiled function -- and an anonymous "runtime"
// frame for any without.
export {
  HEAP_HEADER_WORDS,
  RTHP_BASE,
  RTHP_CEIL,
  RTHP_HEAD,
  RTHP_INIT,
  runtimeFrames,
} from './runtime.js';
export type { RuntimeFrameInfo } from './runtime.js';

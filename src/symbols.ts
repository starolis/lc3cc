// Symbol tables and frame offsets make activation-record layout concrete for
// codegen and inspection tools. Offsets are assigned by check.ts; this file only
// defines the stable data shape shared by compiler stages and callers.
// Each table entry therefore describes resolved storage, not mutable state.

import { sizeInWords } from './ast.js';
import type { CType } from './ast.js';

export type Storage = 'global' | 'param' | 'local';

// One declared variable, resolved to its compile-time location. This
// also serves as metadata for stack and data inspection.
//
// `initValue` is populated only on global entries: the constant-folded
// initializer (0 when the source wrote none, following C's zero-initialized
// default), for codegen to place directly into the R4 data section.
export interface VarSymbol {
  name: string;
  type: CType;
  storage: Storage;
  offset: number;
  initValue?: number;
  // Populated only on an aggregate (array) entry with a string-literal
  // initializer, global or local: the exact words the
  // array's storage should hold, already padded to sizeInWords(type).
  // Scalars keep using `initValue`, so no existing symbol-table snapshot
  // changes shape.
  initWords?: number[];
  // Set only on `const`-qualified globals (locals keep their const-ness in
  // the checker's ScopeEntry instead). Left undefined for non-const symbols
  // so it never appears in symbol-table equality snapshots — the checker's
  // modifiable-lvalue gate reads it to reject writes to a const global.
  isConst?: boolean;
}

// A compiled function's frame: parameters at R5+4.. and locals at
// R5+0, R5-1, ... , both in declaration/encounter order.
// Nested-block and for-init locals are allocated flat into `locals` — one
// slot each, with no reuse. Only functions with a body get a frame;
// prototype-only declarations and builtins are signature-only and never
// appear here (codegen has nothing to lay out for them).
export interface FuncFrame {
  name: string;
  returnType: CType;
  params: VarSymbol[];
  locals: VarSymbol[];
}

export interface SymbolTables {
  globals: VarSymbol[];
  functions: Map<string, FuncFrame>;
}

// Total words a frame's locals occupy. Temporaries sit below this, so it is
// also the offset base for FnCtx.tempOffset. Derived rather than stored so
// FuncFrame stays a pure description of the layout.
export function localWordCount(frame: FuncFrame): number {
  return frame.locals.reduce((sum, s) => sum + sizeInWords(s.type), 0);
}

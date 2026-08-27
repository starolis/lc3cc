// The one source-order-aware resolver for ordinary identifiers.
// Variables and functions share a single namespace in C (Ch 14 section
// 14.2.1.1 / Appendix D section D.4), so ONE scope stack owns both. check.ts
// drives it (declaring names, resolving occurrences, stamping the resolved
// symbol onto each Ident/VarDecl node); codegen.ts reads those stamps instead
// of re-deriving scope structure of its own — so the two passes can never
// disagree about which declaration an occurrence binds to.
//
// The stack's bottom frame (scopes[0]) is the file scope: globals and
// functions in source order. Above it sit a function's params+outer-body
// frame (one frame — a body local that repeats a parameter name is a
// redeclaration, not a shadow) and one frame per nested block.
//
// Source-order visibility (declare-before-use): a file-scope binding records
// the index of its FIRST declaration in program.decls. A body being checked
// carries the index of its own function definition; a file-scope name is
// visible to it only when that name was declared at or before that index (a
// function's own name is declared before its body, so self-recursion resolves).
// Inner (param/local) frames are never index-gated — their visibility is the
// statement walk's own left-to-right order.

import type { CType } from './ast.js';
import type { VarSymbol } from './symbols.js';

export interface VarBinding {
  kind: 'var';
  symbol: VarSymbol;
  isConst: boolean;
  // Per-declaration assignment state. A local declared without an initializer
  // starts unassigned; reading it warns once (warnedUnassigned latches so the
  // warning is not repeated). Globals and params start assigned.
  assigned: boolean;
  warnedUnassigned: boolean;
  // Source-order declaration index; meaningful only for file-scope (global)
  // bindings. Params/locals use ALWAYS_VISIBLE.
  declaredAt: number;
}

export interface FuncBinding {
  kind: 'func';
  name: string;
  returnType: CType;
  params: CType[];
  variadic: boolean;
  isBuiltin: boolean;
  hasBody: boolean;
  declaredAt: number;
}

export type Binding = VarBinding | FuncBinding;

// Builtins (and inner-scope variables) are visible everywhere they can be
// named; a real program declaration is at index 0 or greater, so a sentinel
// below zero is never gated out.
export const ALWAYS_VISIBLE = -1;

export class Resolver {
  private readonly scopes: Map<string, Binding>[] = [new Map()];

  get atFileScope(): boolean {
    return this.scopes.length === 1;
  }

  pushScope(): void {
    this.scopes.push(new Map());
  }

  popScope(): void {
    if (this.scopes.length === 1) throw new Error('scopes: cannot pop the file scope');
    this.scopes.pop();
  }

  // Declare a name in the innermost scope. Callers detect a same-scope
  // duplicate with lookupInCurrentScope BEFORE calling this.
  declare(name: string, binding: Binding): void {
    this.scopes[this.scopes.length - 1].set(name, binding);
  }

  lookupInCurrentScope(name: string): Binding | undefined {
    return this.scopes[this.scopes.length - 1].get(name);
  }

  // The visible binding for `name` at file-scope declaration index `atIndex`,
  // searching innermost-first. A file-scope binding declared after `atIndex`
  // is not yet visible (returns undefined); use declaredLater to distinguish
  // that case from a truly undeclared name.
  resolve(name: string, atIndex: number): Binding | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const binding = this.scopes[i].get(name);
      if (!binding) continue;
      if (i === 0 && binding.declaredAt > atIndex) return undefined;
      return binding;
    }
    return undefined;
  }

  // True when `name` exists at file scope but is declared later than
  // `atIndex` — the "used before its declaration" case, distinct from an
  // undeclared name.
  declaredLater(name: string, atIndex: number): boolean {
    const binding = this.scopes[0].get(name);
    return binding !== undefined && binding.declaredAt > atIndex;
  }

  fileScopeBinding(name: string): Binding | undefined {
    return this.scopes[0].get(name);
  }
}

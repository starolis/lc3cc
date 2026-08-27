import type {
  AssignOp,
  BaseSpec,
  BinaryOp,
  Block,
  DoWhile,
  Expr,
  For,
  FuncDecl,
  If,
  Param,
  Program,
  Return,
  ScalarType,
  Stmt,
  StructDecl,
  StructMemberDecl,
  Switch,
  SwitchCase,
  TopLevelDecl,
  TypeSpec,
  TypedefDecl,
  UnaryOp,
  VarDecl,
  While,
} from './ast.js';
import type { CcDiagnostic } from './diagnostics.js';
import {
  ARRAY_BRACE_INIT,
  BARE_STRUCT_FORWARD,
  BLOCK_SCOPE_TYPE_DECLARATION,
  keywordFeatureMessage,
  STRUCT_MEMBER_ARRAY,
  SIZEOF_EXPRESSION,
  TAGLESS_STRUCT_TYPEDEF,
  TYPEDEF_NAME_SHADOWING,
  UNSPECIFIED_ARRAY_DIMENSION,
  VARIADIC,
} from './features.js';
import { REJECTED_KEYWORDS, type Token, type TokenKind } from './tokens.js';

const TYPE_KEYWORDS = new Set<string>(['int', 'char', 'bool', 'void']);

// Every recursive expression-nesting form re-enters the
// recursive-descent chain, tens of JS call frames per level, so a few
// hundred levels of nesting overflows the JS stack (uncaught RangeError).
// The forms differ sharply in how many JS frames each level costs, so they
// overflow at different raw depths (measured empirically on this runtime,
// cold process, no JIT warm-up — the realistic case for a student's first
// paste of a pathological expression): nested calls `f(f(f(...)))` overflow
// around depth ~255 (the tightest), grouping parens around ~242,
// right-associative assignment chains `a=a=...=a` around ~2000, unary-prefix
// chains around ~2000, chained ternaries around ~3000 (then-nested) to
// ~6000 (else-nested). 151 is well below the lowest of those and far above
// any realistic expression (20-30 levels is already absurd for real code).
//
// A single shared exprDepth counter, incremented at FOUR choke points that
// together cover EVERY way the BUILT expression tree can grow deep. The
// Recursive re-entry points are grouping parens (parsePrimary's '(' ->
// parseAssignment),
// call arguments (parseArgList -> parseAssignment), unary-prefix chains
// (parseUnary self-recursion), ternaries nesting through the THEN operand OR
// the ELSE operand (parseConditional), and right-associative assignment chains
// (parseAssignment value recursion). Binary levels are iterative, but a
// left-associative loop still BUILDS a left-deep tree whose spine the checker
// and codegen descend recursively — so guard #4 counts each fold too. The four
// guards:
//
//   1. parseUnary (entry) — grouping parens, call arguments, casts, and
//      unary-prefix chains all keep an *active* parseUnary frame on the stack
//      per level (parens/calls reach the next level via parsePrimary, which is
//      below parseUnary; casts/unary via direct self-recursion), so one counter
//      here catches all four.
//   2. parseConditional (both ternary operands) — a ternary chain can nest
//      through EITHER the THEN slot (`a?b?c?...`) or the ELSE slot
//      (`a?b:c?d:...`). Each level's condition passes through parseUnary only
//      transiently (push, parse a leaf, pop) before either recursion begins,
//      so #1 misses both slots. One increment placed before `then` and
//      wrapping both `then` and `else` in a single try/finally catches every
//      ternary-nesting level, whichever slot it threads through.
//   3. parseAssignment (the value recursion) — a right-associative chain
//      `a=a=...=a` recurses through the value operand, whose target passes
//      through parseUnary only transiently before the recursion, so #1 misses
//      it too. The guard sits on the value recursion itself.
//   4. parseBinaryLevel (each fold) — a left-associative binary loop is
//      iterative, so it keeps no active frame per operand and #1-#3 miss it,
//      yet it BUILDS a left-deep tree (`a+b+c+...`) whose spine the checker and
//      codegen descend recursively. Each fold increments the counter (restored
//      on exit) so a chain past MAX_EXPR_DEPTH is rejected before it can
//      overflow a downstream recursive consumer.
//
// Every increment uses try/finally to decrement on all exit paths (including
// the depth check firing as the exception unwinds), so the counter is exact
// per exit and tracks the depth of the BUILT subtree along the current path:
// a flat chain `a+b+c+...` climbs one per fold (guard #4) and unwinds fully
// when the level returns, so sibling expressions and statements start clean.
//
// Why 151, not a round 150: parseUnary is the re-entry point for the
// innermost leaf token (the literal/identifier that stops the recursion) too,
// not only for each nesting level, so M real levels of paren/unary nesting
// reach M+1. 151 makes 150 real levels the last that compiles and 151 the
// first rejected. The ternary and assignment guards are calibrated to the
// same boundary: an M-level ternary/assignment chain also reaches M+1 at its
// innermost leaf (via that leaf's parseUnary), so 150 compiles and 151
// rejects there too. One documented consequence of guard #3: an expression in
// an assignment's value slot (`x = EXPR`) carries one extra count for the
// enclosing `=`, so paren/unary/ternary nesting *inside* an assignment RHS
// caps one level lower (149) than the same nesting in a non-assignment slot
// (150). Both are far above realistic and far below every raw-overflow
// threshold above, so the counter stays crash-safe for all forms with margin.
const MAX_EXPR_DEPTH = 151;

// Statements nest recursively too — nested blocks ({ { ... } }),
// controlled statements (if/while/do/for/switch bodies), and else-if chains
// (each `else if` nests through the If's else slot) all re-enter
// parseStatement while the enclosing call's frame is still on the stack, and
// the checker and codegen descend the same tree recursively afterward. Until
// this guard, that was the ONE pathology with no named diagnostic: ~4000
// levels overflowed the JS stack and surfaced as compileC's "internal
// compiler error — please report this program", which teaches the wrong
// lesson when the truth is a capacity limit. Measured on this runtime:
// nested blocks, nested ifs, and nested whiles all survive the full pipeline
// at 2000 levels and overflow between 2000 and 4000. 250 keeps ~10x margin
// below the tightest measured threshold and is far above realistic code
// (even a generated 200-arm else-if dispatch fits). parseStatement is the
// single choke point every nesting form passes through, so one counter
// there covers them all. Why 251, not a round 250: like MAX_EXPR_DEPTH's
// leaf rule, the innermost CONTENT of a nesting chain costs one more level.
// A function body's block does NOT pass through parseStatement, so N nested
// blocks sit at depths 1..N — but a plain statement inside the innermost
// block passes through parseStatement itself, reaching N+1 (a declaration
// routes through parseLocalVarDeclList instead and does not). 251 makes 250
// real levels of block nesting the last that always compiles, whatever the
// innermost statement is. A chain of N controlled statements
// (`if (1) if (1) ...`) likewise puts its innermost controlled statement at
// N+1, so 250 controlled levels compile and 251 is the first rejected.
const MAX_STMT_DEPTH = 251;

const ASSIGN_OPS: Partial<Record<TokenKind, AssignOp>> = {
  assign: '=',
  pluseq: '+=',
  minuseq: '-=',
  stareq: '*=',
  slasheq: '/=',
  percenteq: '%=',
  ampeq: '&=',
  pipeeq: '|=',
  careteq: '^=',
  shleq: '<<=',
  shreq: '>>=',
};

// Table-driven binary levels, tightest to loosest (standard C precedence from
// Appendix D). Each level parses its operands via the next
// tighter level, folding left-associatively.
const MULTIPLICATIVE: Partial<Record<TokenKind, BinaryOp>> = {
  star: '*',
  slash: '/',
  percent: '%',
};
const ADDITIVE: Partial<Record<TokenKind, BinaryOp>> = { plus: '+', minus: '-' };
const SHIFT: Partial<Record<TokenKind, BinaryOp>> = { shl: '<<', shr: '>>' };
const RELATIONAL: Partial<Record<TokenKind, BinaryOp>> = { lt: '<', le: '<=', gt: '>', ge: '>=' };
const EQUALITY: Partial<Record<TokenKind, BinaryOp>> = { eqeq: '==', ne: '!=' };
const BIT_AND: Partial<Record<TokenKind, BinaryOp>> = { amp: '&' };
const BIT_XOR: Partial<Record<TokenKind, BinaryOp>> = { caret: '^' };
const BIT_OR: Partial<Record<TokenKind, BinaryOp>> = { pipe: '|' };
const LOGICAL_AND: Partial<Record<TokenKind, BinaryOp>> = { andand: '&&' };
const LOGICAL_OR: Partial<Record<TokenKind, BinaryOp>> = { oror: '||' };

class ParseError extends Error {
  constructor(
    message: string,
    readonly synchronized = false,
  ) {
    super(message);
  }
}

class Parser {
  private pos = 0;
  private exprDepth = 0;
  private stmtDepth = 0;
  private readonly diagnostics: CcDiagnostic[] = [];
  private readonly typedefNames = new Set<string>();

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): Program {
    const decls: TopLevelDecl[] = [];
    while (!this.atEnd()) {
      try {
        decls.push(...this.parseTopLevelDecl());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        // No stop predicate: unlike parseStmtList's catch, nothing encloses
        // this loop to consume a '}' scope-aware recovery would leave
        // behind — a top-level failure can unwind here before parseBlock
        // ever runs (e.g. a bad parameter list), so the function's closing
        // brace has no block left to claim it. Sweep it up as junk instead.
        if (!e.synchronized) this.synchronize();
      }
    }
    return { kind: 'Program', decls, line: 1, col: 1 };
  }

  // ---- declarations ----

  private parseTopLevelDecl(): TopLevelDecl[] {
    if (this.checkKeyword('typedef')) return this.parseTypedefDecl();
    if (this.startsStructDefinition()) {
      const decl = this.parseStructDefinition();
      this.expectPunct('semicolon', ';', 'to end the struct definition');
      return [decl];
    }
    if (this.startsBareStructForward()) this.fail(BARE_STRUCT_FORWARD.message);

    const start = this.peek()!;
    const isConst = this.matchKeyword('const') !== null;
    const base = this.parseBaseType();
    const pointerDepth = this.parsePointerDepth();
    const nameTok = this.expectOrdinaryIdentifier('for the declaration');
    if (this.check('lparen')) {
      return [
        this.parseFuncDeclContinuation(start, { base, pointerDepth, dims: [] }, nameTok.text),
      ];
    }
    const dims = this.parseDimensions(false);
    return this.parseVarDeclListContinuation(
      start,
      { base, pointerDepth, dims },
      isConst,
      nameTok.text,
    );
  }

  private parseTypedefDecl(): TopLevelDecl[] {
    const start = this.expectKeyword('typedef', 'to start the type alias');
    if (this.checkKeyword('struct') && this.peekAt(1)?.kind === 'lbrace') {
      const tagless = this.peek()!;
      this.skipThroughDeclaration();
      this.failAt(tagless, TAGLESS_STRUCT_TYPEDEF.message, true);
    }

    let structDecl: StructDecl | null = null;
    let base: BaseSpec;
    let pointerDepth = 0;
    if (this.startsStructDefinition()) {
      structDecl = this.parseStructDefinition();
      base = { struct: structDecl.tag };
    } else {
      base = this.parseBaseType();
      pointerDepth = this.parsePointerDepth();
    }

    const nameTok = this.expectIdentifier('for the typedef');
    this.expectPunct('semicolon', ';', 'to end the typedef');

    const decl: TypedefDecl = {
      kind: 'TypedefDecl',
      name: nameTok.text,
      typeSpec: { base, pointerDepth, dims: [] },
      line: start.line,
      col: start.col,
    };
    // The contextual name becomes visible only after the complete declaration
    // (including its semicolon) has parsed successfully.
    this.typedefNames.add(nameTok.text);
    return structDecl ? [structDecl, decl] : [decl];
  }

  private parseStructDefinition(): StructDecl {
    const start = this.expectKeyword('struct', 'to start the struct definition');
    const tag = this.expectIdentifier('for the struct tag');
    this.expectPunct('lbrace', '{', 'to start the struct member list');
    try {
      if (this.check('rbrace')) this.fail('a struct definition needs at least one member');

      const members: StructMemberDecl[] = [];
      while (!this.check('rbrace') && !this.atEnd()) {
        const memberStart = this.peek()!;
        const base = this.parseBaseType();
        const pointerDepth = this.parsePointerDepth();
        const name = this.expectIdentifier('for the struct member');
        const dims = this.parseStructMemberDimension();
        this.expectPunct('semicolon', ';', 'to end the struct member declaration');
        members.push({
          kind: 'StructMemberDecl',
          name: name.text,
          typeSpec: { base, pointerDepth, dims },
          line: memberStart.line,
          col: memberStart.col,
        });
      }
      this.expectPunct('rbrace', '}', 'to close the struct definition');
      return { kind: 'StructDecl', tag: tag.text, members, line: start.line, col: start.col };
    } catch (error) {
      if (!(error instanceof ParseError) || error.synchronized) throw error;
      this.skipThroughStructDefinition();
      throw new ParseError(error.message, true);
    }
  }

  private parseStructMemberDimension(): (Expr | null)[] {
    if (!this.match('lbracket')) return [];
    if (this.check('rbracket')) {
      const unspecified = this.peek()!;
      this.skipThroughStructDefinition();
      this.failAt(unspecified, UNSPECIFIED_ARRAY_DIMENSION.message, true);
    }
    const dim = this.parseConditional();
    this.expectPunct('rbracket', ']', 'to close the struct member array dimension');
    if (this.check('lbracket')) {
      const secondDimension = this.peek()!;
      this.skipThroughStructDefinition();
      this.failAt(secondDimension, STRUCT_MEMBER_ARRAY.message, true);
    }
    return [dim];
  }

  private startsStructDefinition(): boolean {
    return (
      this.checkKeyword('struct') &&
      this.peekAt(1)?.kind === 'identifier' &&
      this.peekAt(2)?.kind === 'lbrace'
    );
  }

  private startsBareStructForward(): boolean {
    return (
      this.checkKeyword('struct') &&
      this.peekAt(1)?.kind === 'identifier' &&
      this.peekAt(2)?.kind === 'semicolon'
    );
  }

  private startsBlockScopeTypeDeclaration(): boolean {
    return this.checkKeyword('typedef') || this.startsStructDefinition();
  }

  private rejectBlockScopeTypeDeclaration(): never {
    return this.rejectScopedTypeDeclaration(BLOCK_SCOPE_TYPE_DECLARATION.message);
  }

  private rejectScopedTypeDeclaration(message: string): never {
    const start = this.peek()!;
    this.skipThroughDeclaration();
    return this.failAt(start, message, true);
  }

  private skipThroughDeclaration(): void {
    let braceDepth = 0;
    while (this.peek()) {
      const tok = this.advance();
      if (tok.kind === 'lbrace') braceDepth++;
      if (tok.kind === 'rbrace' && braceDepth > 0) braceDepth--;
      if (tok.kind === 'semicolon' && braceDepth === 0) break;
    }
  }

  private skipThroughStructDefinition(): void {
    let braceDepth = 1;
    while (this.peek() && braceDepth > 0) {
      const tok = this.advance();
      if (tok.kind === 'lbrace') braceDepth++;
      if (tok.kind === 'rbrace') braceDepth--;
    }
    while (this.peek()) {
      if (this.advance().kind === 'semicolon') return;
    }
  }

  private parseFuncDeclContinuation(start: Token, returnSpec: TypeSpec, name: string): FuncDecl {
    this.advance(); // '('
    const params = this.parseParamList();
    this.expectPunct('rparen', ')', 'to close the parameter list');
    if (this.match('semicolon')) {
      return { kind: 'FuncDecl', name, returnSpec, params, line: start.line, col: start.col };
    }
    const body = this.parseBlock();
    return { kind: 'FuncDecl', name, returnSpec, params, body, line: start.line, col: start.col };
  }

  private parseParamList(): Param[] {
    const params: Param[] = [];
    if (this.check('rparen')) return params;
    if (this.checkKeyword('void') && this.peekAt(1)?.kind === 'rparen') {
      this.advance(); // 'void'
      return params;
    }
    while (true) {
      // A `...` in a parameter list is a user-defined variadic function — a
      // deliberate subset exclusion. Reject it by name, pointing at the
      // '...', instead of falling into parseBaseType's generic type error. The
      // lexer has no ellipsis token, so it arrives as three consecutive dots.
      this.rejectVariadicEllipsis();
      const tok = this.peek();
      const start = tok ?? this.lastToken();
      const base = this.parseBaseType(true);
      const pointerDepth = this.parsePointerDepth();
      const nameTok = this.match('identifier');
      if (nameTok) this.rejectTypedefNameShadow(nameTok);
      // `true`: a parameter's leading dimension may be left unspecified
      // (`int values[]`) — the book's own array-parameter spelling (16.3.3).
      const dims = this.parseDimensions(true);
      params.push({
        kind: 'Param',
        name: nameTok ? nameTok.text : null,
        typeSpec: { base, pointerDepth, dims },
        line: start?.line ?? 1,
        col: start?.col ?? 1,
      });
      if (!this.match('comma')) break;
    }
    return params;
  }

  // The comma-separated declarator sequence WITHOUT its terminating token, so
  // both a statement declaration (which ends in ';') and a for-init
  // declaration (whose ';' is the for-header separator) can share it.
  // Re-reads the pointer depth and dimensions per declarator, because
  // `int *a, b;` declares a pointer and an int — the star binds to the
  // declarator, not the type.
  private parseDeclaratorList(
    start: Token,
    spec: TypeSpec,
    isConst: boolean,
    firstName: string,
  ): VarDecl[] {
    const decls: VarDecl[] = [this.parseDeclaratorTail(start, spec, isConst, firstName)];
    while (this.match('comma')) {
      const pointerDepth = this.parsePointerDepth();
      const nameTok = this.expectOrdinaryIdentifier('for the next declarator');
      const dims = this.parseDimensions(false);
      decls.push(
        this.parseDeclaratorTail(
          nameTok,
          { base: spec.base, pointerDepth, dims },
          isConst,
          nameTok.text,
        ),
      );
    }
    return decls;
  }

  private parseVarDeclListContinuation(
    start: Token,
    spec: TypeSpec,
    isConst: boolean,
    firstName: string,
  ): VarDecl[] {
    const decls = this.parseDeclaratorList(start, spec, isConst, firstName);
    this.expectPunct('semicolon', ';', 'to end the declaration');
    return decls;
  }

  // Rejects a brace initializer before parsing the init expression.
  private parseDeclaratorTail(
    pos: Token,
    typeSpec: TypeSpec,
    isConst: boolean,
    name: string,
  ): VarDecl {
    const decl: VarDecl = {
      kind: 'VarDecl',
      name,
      typeSpec,
      isConst,
      line: pos.line,
      col: pos.col,
    };
    if (this.match('assign')) {
      this.rejectBraceInitializer();
      decl.init = this.parseAssignment();
    }
    return decl;
  }

  private parseBaseType(allowStructDefinition = false): BaseSpec {
    if (allowStructDefinition && this.startsStructDefinition()) {
      // Inline definitions are a ruled subset boundary. Consume the balanced
      // definition without recursively parsing its members, record the one
      // canonical error, and return its tag as a placeholder so the enclosing
      // parameter/local/for declarator can finish without a recovery cascade.
      const start = this.advance(); // 'struct'
      const tag = this.advance();
      this.advance(); // '{'
      let braceDepth = 1;
      while (this.peek() && braceDepth > 0) {
        const tok = this.advance();
        if (tok.kind === 'lbrace') braceDepth++;
        if (tok.kind === 'rbrace') braceDepth--;
      }
      this.diagnostics.push({
        line: start.line,
        col: start.col,
        message: BLOCK_SCOPE_TYPE_DECLARATION.message,
        severity: 'error',
      });
      return { struct: tag.text };
    }

    const tok = this.peek();
    if (tok && tok.kind === 'keyword' && TYPE_KEYWORDS.has(tok.text)) {
      this.advance();
      return tok.text as ScalarType;
    }
    // `_Bool` is standard C's spelling of the boolean type (Ch 12 section
    // 12.2.1) — the same CType as stdbool.h's `bool`.
    if (tok && tok.kind === 'keyword' && tok.text === '_Bool') {
      this.advance();
      return 'bool';
    }
    if (tok && tok.kind === 'keyword' && tok.text === 'struct') {
      this.advance();
      const tag = this.expectIdentifier('after struct');
      return { struct: tag.text };
    }
    if (tok && tok.kind === 'identifier' && this.typedefNames.has(tok.text)) {
      this.advance();
      return { typedefName: tok.text };
    }
    if (tok && tok.kind === 'keyword' && REJECTED_KEYWORDS.has(tok.text)) {
      this.fail(this.reservedKeywordMessage(tok.text));
    }
    this.fail('expected a type (int, char, bool, void, struct <tag>, or a declared typedef)');
  }

  // A declaration or abstract type name's syntax: the base, the run of `*`s,
  // and any bracketed dimensions. Dimensions stay as unfolded Exprs — only
  // check.ts can fold a constant expression in the correct source-order
  // type environment.
  private parsePointerDepth(): number {
    let depth = 0;
    while (this.match('star')) depth++;
    return depth;
  }

  // Call after a declaration's name, or after the stars in an abstract type
  // name. `allowUnspecifiedFirst` is true only in a parameter list, where
  // `int values[]` is the book's own array-parameter spelling (16.3.3).
  private parseDimensions(allowUnspecifiedFirst: boolean): (Expr | null)[] {
    const dims: (Expr | null)[] = [];
    while (this.match('lbracket')) {
      if (this.check('rbracket')) {
        if (dims.length > 0 || !allowUnspecifiedFirst) {
          this.fail(UNSPECIFIED_ARRAY_DIMENSION.message);
        }
        dims.push(null);
      } else {
        dims.push(this.parseConditional());
      }
      this.expectPunct('rbracket', ']', 'to close the array dimension');
    }
    return dims;
  }

  private rejectBraceInitializer(): void {
    if (this.check('lbrace')) this.fail(ARRAY_BRACE_INIT.message);
  }

  // ---- statements ----

  private parseBlock(): Block {
    const open = this.expectPunct('lbrace', '{', 'to start the block');
    const stmts = this.parseStmtList(() => this.check('rbrace'));
    const close = this.expectPunct('rbrace', '}', 'to close the block');
    return { kind: 'Block', stmts, line: open.line, col: open.col, endLine: close.line };
  }

  // Shared by parseBlock and parseCaseStmts: a comma-separated local
  // declaration (`int a, b = 2;`) must splice as consecutive sibling
  // VarDecl statements, not nest inside a synthetic extra Block — so this
  // is the one place that decides "declaration vs. other statement" and
  // flattens accordingly.
  private parseStmtList(stop: () => boolean): Stmt[] {
    const stmts: Stmt[] = [];
    while (!stop() && !this.atEnd()) {
      try {
        const tok = this.peek()!;
        if (this.startsBareStructForward()) {
          this.rejectScopedTypeDeclaration(BARE_STRUCT_FORWARD.message);
        } else if (this.startsBlockScopeTypeDeclaration()) {
          this.rejectBlockScopeTypeDeclaration();
        } else if (this.startsVarDecl(tok)) {
          stmts.push(...this.parseLocalVarDeclList());
        } else {
          stmts.push(this.parseStatement());
        }
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        if (!e.synchronized) this.synchronize(stop);
      }
    }
    return stmts;
  }

  private startsVarDecl(tok: Token): boolean {
    if (tok.kind === 'identifier') return this.typedefNames.has(tok.text);
    return (
      tok.kind === 'keyword' &&
      (tok.text === 'const' ||
        tok.text === '_Bool' ||
        tok.text === 'struct' ||
        TYPE_KEYWORDS.has(tok.text))
    );
  }

  private parseLocalVarDeclList(): VarDecl[] {
    const start = this.peek()!;
    const isConst = this.matchKeyword('const') !== null;
    const base = this.parseBaseType(true);
    const pointerDepth = this.parsePointerDepth();
    const nameTok = this.expectOrdinaryIdentifier('for the declaration');
    const dims = this.parseDimensions(false);
    return this.parseVarDeclListContinuation(
      start,
      { base, pointerDepth, dims },
      isConst,
      nameTok.text,
    );
  }

  // The depth guard wraps the dispatch (parseStatementInner) so every
  // statement-nesting form — nested blocks, controlled statements, else-if
  // chains — is bounded by one counter. try/finally decrements on every exit
  // path, including the depth check firing, so sibling statements at the same
  // level start clean (the same discipline as the exprDepth guards).
  private parseStatement(): Stmt {
    this.stmtDepth++;
    try {
      if (this.stmtDepth > MAX_STMT_DEPTH) {
        this.fail('statements too deeply nested — flatten the code or split it into functions');
      }
      return this.parseStatementInner();
    } finally {
      this.stmtDepth--;
    }
  }

  private parseStatementInner(): Stmt {
    const tok = this.peek();
    if (!tok) this.fail('expected a statement');

    if (this.startsBareStructForward()) {
      this.rejectScopedTypeDeclaration(BARE_STRUCT_FORWARD.message);
    }
    if (this.startsBlockScopeTypeDeclaration()) this.rejectBlockScopeTypeDeclaration();
    if (this.startsVarDecl(tok)) this.fail(this.declAsControlledStatementMessage());

    if (tok.kind === 'lbrace') return this.parseBlock();
    if (tok.kind === 'semicolon') {
      this.advance();
      return { kind: 'ExprStmt', expr: null, line: tok.line, col: tok.col };
    }
    if (tok.kind === 'keyword') {
      switch (tok.text) {
        case 'if':
          return this.parseIf();
        case 'while':
          return this.parseWhile();
        case 'do':
          return this.parseDoWhile();
        case 'for':
          return this.parseFor();
        case 'switch':
          return this.parseSwitch();
        case 'return':
          return this.parseReturn();
        case 'break':
          this.advance();
          this.expectPunct('semicolon', ';', 'to end the statement');
          return { kind: 'Break', line: tok.line, col: tok.col };
        case 'continue':
          this.advance();
          this.expectPunct('semicolon', ';', 'to end the statement');
          return { kind: 'Continue', line: tok.line, col: tok.col };
        case 'true':
        case 'false':
        case 'sizeof':
          return this.parseExprStatement();
        default:
          if (REJECTED_KEYWORDS.has(tok.text)) this.fail(this.reservedKeywordMessage(tok.text));
          this.fail(`'${tok.text}' cannot start a statement`);
      }
    }
    return this.parseExprStatement();
  }

  private parseExprStatement(): Stmt {
    const start = this.peek()!;
    const expr = this.parseExprTopLevel();
    this.expectPunct('semicolon', ';', 'to end the statement');
    return { kind: 'ExprStmt', expr, line: start.line, col: start.col };
  }

  private parseIf(): If {
    const start = this.advance(); // 'if'
    this.expectPunct('lparen', '(', "after 'if'");
    const cond = this.parseExprTopLevel();
    this.expectPunct('rparen', ')', 'to close the condition');
    const then = this.parseStatement();
    let elseBranch: Stmt | null = null;
    if (this.matchKeyword('else')) elseBranch = this.parseStatement();
    return { kind: 'If', cond, then, else: elseBranch, line: start.line, col: start.col };
  }

  private parseWhile(): While {
    const start = this.advance(); // 'while'
    this.expectPunct('lparen', '(', "after 'while'");
    const cond = this.parseConditionRejectingDeclaration('while', start);
    const body = this.parseStatement();
    return { kind: 'While', cond, body, line: start.line, col: start.col };
  }

  private parseDoWhile(): DoWhile {
    const start = this.advance(); // 'do'
    const body = this.parseStatement();
    this.expectKeyword('while', "to close the 'do' body");
    this.expectPunct('lparen', '(', "after 'while'");
    const cond = this.parseConditionRejectingDeclaration('do-while', start);
    this.expectPunct('semicolon', ';', 'to end the do-while statement');
    return { kind: 'DoWhile', cond, body, line: start.line, col: start.col };
  }

  // `while (int i = 0)` would otherwise fall into parseExprTopLevel,
  // which met a type keyword where it wanted an expression and produced a
  // three-error cascade. The subset table promises every rejection is a single
  // named error. C forbids a declaration in a while/do-while condition (unlike
  // for-init and unlike C++), so there is nothing to support — only a clear
  // rejection. On seeing a declaration-start token (including a contextual
  // typedef name), record the one error and skip the condition to its ')' in
  // place, so the loop body still parses and nothing cascades; the returned
  // placeholder condition never runs (compilation fails on the recorded error).
  private parseConditionRejectingDeclaration(loop: 'while' | 'do-while', start: Token): Expr {
    const tok = this.peek();
    if (tok && this.startsVarDecl(tok)) {
      this.diagnostics.push({
        line: tok.line,
        col: tok.col,
        message: `a variable can't be declared in a ${loop} condition — declare it before the loop`,
        severity: 'error',
      });
      this.skipToConditionClose();
      return { kind: 'IntLit', value: 0, line: start.line, col: start.col };
    }
    const cond = this.parseExprTopLevel();
    this.expectPunct('rparen', ')', 'to close the condition');
    return cond;
  }

  // Skip balanced to the ')' that closes the current condition and consume it,
  // so parsing resumes cleanly at the loop body.
  private skipToConditionClose(): void {
    let depth = 1;
    while (this.peek()) {
      const t = this.advance();
      if (t.kind === 'lparen') depth++;
      else if (t.kind === 'rparen' && --depth === 0) return;
    }
  }

  private parseFor(): For {
    const start = this.advance(); // 'for'
    this.expectPunct('lparen', '(', "after 'for'");

    let init: Expr | VarDecl[] | null = null;
    const initTok = this.peek();
    if (initTok && this.startsVarDecl(initTok)) {
      const isConst = this.matchKeyword('const') !== null;
      const base = this.parseBaseType(true);
      const pointerDepth = this.parsePointerDepth();
      const nameTok = this.expectOrdinaryIdentifier('for the loop variable');
      const dims = this.parseDimensions(false);
      // C99 allows comma-separated declarators in the init clause
      // (`for (int i = 0, j = 3; ...)`).
      init = this.parseDeclaratorList(initTok, { base, pointerDepth, dims }, isConst, nameTok.text);
    } else if (!this.check('semicolon')) {
      init = this.parseExprTopLevel();
    }
    this.expectPunct('semicolon', ';', "to separate the for-loop's init and condition");

    const cond = this.check('semicolon') ? null : this.parseExprTopLevel();
    this.expectPunct('semicolon', ';', "to separate the for-loop's condition and update");

    const update = this.check('rparen') ? null : this.parseExprTopLevel();
    this.expectPunct('rparen', ')', 'to close the for-loop header');

    const body = this.parseStatement();
    return { kind: 'For', init, cond, update, body, line: start.line, col: start.col };
  }

  private parseSwitch(): Switch {
    const start = this.advance(); // 'switch'
    this.expectPunct('lparen', '(', "after 'switch'");
    const expr = this.parseExprTopLevel();
    this.expectPunct('rparen', ')', 'to close the switch expression');
    this.expectPunct('lbrace', '{', 'to start the switch body');

    const cases: SwitchCase[] = [];
    let defaultIndex: number | null = null;
    while (!this.check('rbrace') && !this.atEnd()) {
      const caseTok = this.peek()!;
      if (caseTok.kind === 'keyword' && caseTok.text === 'case') {
        this.advance();
        const value = this.parseExprTopLevel();
        this.expectPunct('colon', ':', "after the 'case' value");
        cases.push({
          kind: 'SwitchCase',
          value,
          stmts: this.parseCaseStmts(),
          line: caseTok.line,
          col: caseTok.col,
        });
      } else if (caseTok.kind === 'keyword' && caseTok.text === 'default') {
        this.advance();
        this.expectPunct('colon', ':', "after 'default'");
        if (defaultIndex === null) defaultIndex = cases.length;
        cases.push({
          kind: 'SwitchCase',
          value: null,
          stmts: this.parseCaseStmts(),
          line: caseTok.line,
          col: caseTok.col,
        });
      } else {
        this.fail("expected 'case' or 'default' in a switch body");
      }
    }
    this.expectPunct('rbrace', '}', 'to close the switch body');
    return { kind: 'Switch', expr, cases, defaultIndex, line: start.line, col: start.col };
  }

  private parseCaseStmts(): Stmt[] {
    return this.parseStmtList(
      () => this.check('rbrace') || this.checkKeyword('case') || this.checkKeyword('default'),
    );
  }

  private parseReturn(): Return {
    const start = this.advance(); // 'return'
    if (this.match('semicolon')) return { kind: 'Return', line: start.line, col: start.col };
    const expr = this.parseExprTopLevel();
    this.expectPunct('semicolon', ';', 'to end the return statement');
    return { kind: 'Return', expr, line: start.line, col: start.col };
  }

  // ---- expressions ----
  // Entry point for any statement-level expression slot. Rejects a stray
  // top-level comma by name (comma is only legal in declarator lists and
  // call-argument lists, both handled by their own parse paths, never here).
  private parseExprTopLevel(): Expr {
    const expr = this.parseAssignment();
    if (this.check('comma')) this.fail(this.commaOperatorMessage());
    return expr;
  }

  private parseAssignment(): Expr {
    const target = this.parseConditional();
    const tok = this.peek();
    const op = tok ? ASSIGN_OPS[tok.kind] : undefined;
    if (!op || !tok) return target;
    this.advance();
    // Depth guard #3: a right-associative assignment chain
    // (`a=a=...=a`) recurses here through the value operand, keeping this
    // frame open per level. The target above only passes through parseUnary
    // transiently (it returns before this recursion begins), so parseUnary's
    // counter never sees the chain — this is its own choke point. try/finally
    // decrements on every exit path, including the depth check firing.
    this.exprDepth++;
    try {
      if (this.exprDepth > MAX_EXPR_DEPTH) {
        this.fail(
          'expression too deeply nested — simplify it or split it into smaller expressions',
        );
      }
      const value = this.parseAssignment();
      return { kind: 'Assign', op, target, value, line: target.line, col: target.col };
    } finally {
      this.exprDepth--;
    }
  }

  private parseConditional(): Expr {
    const cond = this.parseBinaryLevel(LOGICAL_OR, () =>
      this.parseBinaryLevel(LOGICAL_AND, () => this.parseBitOr()),
    );
    if (!this.match('question')) return cond;
    // Depth guard #2 is a second choke point, alongside parseUnary.
    // A ternary chain can nest through EITHER operand: the THEN slot
    // (`a?b?c?...`, parsed by parseAssignment below) or the ELSE slot
    // (`a?b:c?d:...`, parsed by the parseConditional recursion below). Both
    // recursions run while THIS frame is still on the stack, unlike the cond
    // operand above, which only passes through parseUnary transiently (push,
    // parse a leaf, pop) before this point — so parseUnary's counter never
    // sees a ternary chain in either slot. The increment sits BEFORE `then`
    // and wraps BOTH operands in one try/finally, so a chain nesting through
    // the THEN slot is bounded exactly as one nesting through the ELSE slot
    // (either would otherwise overflow the JS stack raw — measured: then-
    // nested ~3000 levels, else-nested ~6000). try/finally decrements on
    // every exit path, including the depth check firing.
    this.exprDepth++;
    try {
      if (this.exprDepth > MAX_EXPR_DEPTH) {
        this.fail(
          'expression too deeply nested — simplify it or split it into smaller expressions',
        );
      }
      const then = this.parseAssignment();
      this.expectPunct('colon', ':', "to complete the '?:' expression");
      const elseExpr = this.parseConditional();
      return { kind: 'Cond', cond, then, else: elseExpr, line: cond.line, col: cond.col };
    } finally {
      this.exprDepth--;
    }
  }

  private parseBitOr(): Expr {
    return this.parseBinaryLevel(BIT_OR, () =>
      this.parseBinaryLevel(BIT_XOR, () =>
        this.parseBinaryLevel(BIT_AND, () => this.parseEquality()),
      ),
    );
  }

  private parseEquality(): Expr {
    return this.parseBinaryLevel(EQUALITY, () => this.parseRelational());
  }

  private parseRelational(): Expr {
    return this.parseBinaryLevel(RELATIONAL, () => this.parseShift());
  }

  private parseShift(): Expr {
    return this.parseBinaryLevel(SHIFT, () => this.parseAdditive());
  }

  private parseAdditive(): Expr {
    return this.parseBinaryLevel(ADDITIVE, () => this.parseMultiplicative());
  }

  private parseMultiplicative(): Expr {
    return this.parseBinaryLevel(MULTIPLICATIVE, () => this.parseUnary());
  }

  // Depth guard #4: a left-associative binary loop builds a
  // left-deep AST ITERATIVELY, so guards #1-#3 (which track recursive-descent
  // call depth) never see it — yet the checker and codegen descend that left
  // spine RECURSIVELY, and a long enough chain (`1+1+...+1`) overflows the JS
  // stack there with a raw RangeError the parser itself never throws. Count
  // each fold onto the SAME exprDepth counter so the built tree's depth is
  // bounded exactly like recursive nesting: a chain past MAX_EXPR_DEPTH is the
  // named nesting diagnostic, produced before the tree ever reaches a
  // recursive consumer. The increment sits before parsing `right`, so a
  // right-heavy operand (e.g. an additive whose right side is a long
  // multiplicative chain) stacks its own depth on top — matching the true tree
  // height. try/finally restores the counter on every exit path (including the
  // depth check firing) so sibling expressions and later statements start
  // clean, exactly like the other three guards.
  private parseBinaryLevel(ops: Partial<Record<TokenKind, BinaryOp>>, operand: () => Expr): Expr {
    let left = operand();
    let added = 0;
    try {
      while (true) {
        const tok = this.peek();
        const op = tok ? ops[tok.kind] : undefined;
        if (!op) return left;
        this.advance();
        this.exprDepth++;
        added++;
        if (this.exprDepth > MAX_EXPR_DEPTH) {
          this.fail(
            'expression too deeply nested — simplify it or split it into smaller expressions',
          );
        }
        const right = operand();
        left = { kind: 'Binary', op, left, right, line: left.line, col: left.col };
      }
    } finally {
      this.exprDepth -= added;
    }
  }

  private static readonly UNARY_PREFIX: Partial<Record<TokenKind, UnaryOp>> = {
    minus: '-',
    not: '!',
    tilde: '~',
  };

  // Depth guard #1 (of three — see the module-level comment for the complete
  // recursion accounting; the other two are in parseConditional and
  // parseAssignment). This one covers the four forms that keep an active
  // parseUnary frame on the stack per nesting level: grouping parens (via
  // parsePrimary's '(' case -> parseAssignment -> ... -> here), nested call
  // arguments (via parseArgList -> parseAssignment -> ... -> here), casts,
  // and unary-prefix chains (the direct self-recursion below). It does NOT
  // catch ternary chains or assignment chains: those thread through operands whose
  // parseUnary pass is only transient (push, parse a leaf, pop) before the
  // next level's recursion begins, so they never keep a frame open across
  // levels here — hence guards #2 and #3. try/finally so an error path
  // (including the depth check itself failing) still decrements as the
  // exception unwinds back through each enclosing level — the counter is
  // exact on every exit path, and tracks concurrent nesting depth (not total
  // calls): a flat chain like `a+b+c+...` calls parseUnary once per operand
  // but each call returns before the next starts, so it never climbs past 1.
  private parseUnary(): Expr {
    this.exprDepth++;
    try {
      if (this.exprDepth > MAX_EXPR_DEPTH) {
        this.fail(
          'expression too deeply nested — simplify it or split it into smaller expressions',
        );
      }
      const tok = this.peek();
      if (tok) {
        if (tok.kind === 'lparen' && this.startsTypeName(1)) {
          return this.parseCast();
        }
        if (tok.kind === 'keyword' && tok.text === 'sizeof') {
          return this.parseSizeofType();
        }
        const op = Parser.UNARY_PREFIX[tok.kind];
        if (op) {
          this.advance();
          const expr = this.parseUnary();
          return { kind: 'Unary', op, expr, fix: 'none', line: tok.line, col: tok.col };
        }
        if (tok.kind === 'star') {
          this.advance();
          const expr = this.parseUnary();
          return { kind: 'Deref', expr, line: tok.line, col: tok.col };
        }
        if (tok.kind === 'amp') {
          this.advance();
          const expr = this.parseUnary();
          return { kind: 'AddrOf', expr, line: tok.line, col: tok.col };
        }
        if (tok.kind === 'plusplus' || tok.kind === 'minusminus') {
          this.advance();
          const expr = this.parseUnary();
          return {
            kind: 'Unary',
            op: tok.kind === 'plusplus' ? '++' : '--',
            expr,
            fix: 'pre',
            line: tok.line,
            col: tok.col,
          };
        }
      }
      return this.parsePostfix();
    } finally {
      this.exprDepth--;
    }
  }

  private parseSizeofType(): Expr {
    const start = this.expectKeyword('sizeof', 'to start the type measurement');
    if (!this.match('lparen')) {
      this.diagnostics.push({
        line: start.line,
        col: start.col,
        message: SIZEOF_EXPRESSION.message,
        severity: 'error',
      });
      if (!this.skipRejectedBareSizeofOperand()) {
        throw new ParseError(SIZEOF_EXPRESSION.message);
      }
      return { kind: 'IntLit', value: 1, line: start.line, col: start.col };
    }
    if (!this.startsTypeName()) {
      const operand = this.peek() ?? start;
      this.diagnostics.push({
        line: operand.line,
        col: operand.col,
        message: SIZEOF_EXPRESSION.message,
        severity: 'error',
      });
      if (!this.skipRejectedSizeofOperand()) {
        throw new ParseError(SIZEOF_EXPRESSION.message);
      }
      return { kind: 'IntLit', value: 1, line: start.line, col: start.col };
    }
    const spec = this.parseAbstractTypeSpec();
    this.expectPunct('rparen', ')', 'to close the sizeof type name');
    return {
      kind: 'SizeofType',
      spec,
      line: start.line,
      col: start.col,
    };
  }

  // Consume an unsupported bare operand without asking the ordinary parser to
  // diagnose its contents. Stop before the enclosing expression's delimiter;
  // nested calls and subscripts keep their own commas and closing tokens.
  private skipRejectedBareSizeofOperand(): boolean {
    let parenDepth = 0;
    let bracketDepth = 0;
    while (this.peek()) {
      const tok = this.peek()!;
      if (
        tok.kind === 'rbrace' ||
        (tok.kind === 'keyword' && (tok.text === 'case' || tok.text === 'default'))
      ) {
        return false;
      }
      if (tok.kind === 'semicolon') {
        return parenDepth === 0 && bracketDepth === 0;
      }
      if (
        parenDepth === 0 &&
        bracketDepth === 0 &&
        (tok.kind === 'comma' ||
          tok.kind === 'question' ||
          tok.kind === 'rparen' ||
          tok.kind === 'rbracket' ||
          tok.kind === 'colon')
      ) {
        return true;
      }
      this.advance();
      if (tok.kind === 'lparen') parenDepth++;
      else if (tok.kind === 'rparen' && parenDepth > 0) parenDepth--;
      else if (tok.kind === 'lbracket') bracketDepth++;
      else if (tok.kind === 'rbracket' && bracketDepth > 0) bracketDepth--;
    }
    return parenDepth === 0 && bracketDepth === 0;
  }

  // The opening '(' has already been consumed. Skip the rejected expression
  // without building an AST, stopping after its balanced close so parsing can
  // resume in the enclosing expression. A statement/scope boundary before the
  // close is malformed syntax, so leave it for ordinary outer recovery.
  private skipRejectedSizeofOperand(): boolean {
    let parenDepth = 1;
    let bracketDepth = 0;
    while (this.peek()) {
      const tok = this.peek()!;
      if (
        tok.kind === 'semicolon' ||
        tok.kind === 'rbrace' ||
        (tok.kind === 'keyword' && (tok.text === 'case' || tok.text === 'default'))
      ) {
        return false;
      }
      this.advance();
      if (tok.kind === 'lparen') parenDepth++;
      else if (tok.kind === 'rparen') {
        parenDepth--;
        if (parenDepth === 0) return bracketDepth === 0;
      } else if (tok.kind === 'lbracket') bracketDepth++;
      else if (tok.kind === 'rbracket' && bracketDepth > 0) bracketDepth--;
    }
    return false;
  }

  private parseCast(): Expr {
    const start = this.expectPunct('lparen', '(', 'to start the cast type name');
    const spec = this.parseAbstractTypeSpec();
    this.expectPunct('rparen', ')', 'to close the cast type name');
    const expr = this.parseUnary();
    return { kind: 'Cast', spec, expr, line: start.line, col: start.col };
  }

  private parseAbstractTypeSpec(): TypeSpec {
    const base = this.parseBaseType();
    const pointerDepth = this.parsePointerDepth();
    const dims = this.parseDimensions(false);
    return { base, pointerDepth, dims };
  }

  private startsTypeName(offset = 0): boolean {
    const tok = this.peekAt(offset);
    if (!tok) return false;
    if (tok.kind === 'keyword') {
      return TYPE_KEYWORDS.has(tok.text) || tok.text === '_Bool' || tok.text === 'struct';
    }
    return tok.kind === 'identifier' && this.typedefNames.has(tok.text);
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    while (true) {
      const tok = this.peek();
      if (!tok) return expr;
      if (tok.kind === 'lparen') {
        if (expr.kind !== 'Ident') this.fail('only a named function can be called');
        this.advance();
        const args = this.parseArgList();
        this.expectPunct('rparen', ')', 'to close the argument list');
        expr = { kind: 'Call', callee: expr.name, args, line: expr.line, col: expr.col };
      } else if (tok.kind === 'plusplus' || tok.kind === 'minusminus') {
        this.advance();
        expr = {
          kind: 'Unary',
          op: tok.kind === 'plusplus' ? '++' : '--',
          expr,
          fix: 'post',
          line: expr.line,
          col: expr.col,
        };
      } else if (tok.kind === 'lbracket') {
        this.advance();
        const index = this.parseExprTopLevel();
        this.expectPunct('rbracket', ']', 'to close the subscript');
        expr = { kind: 'Subscript', array: expr, index, line: expr.line, col: expr.col };
      } else if (tok.kind === 'dot' || tok.kind === 'arrow') {
        this.advance();
        const member = this.expectIdentifier(`after '${tok.text}'`);
        expr = {
          kind: 'Member',
          object: expr,
          member: member.text,
          arrow: tok.kind === 'arrow',
          line: expr.line,
          col: expr.col,
        };
      } else {
        return expr;
      }
    }
  }

  private parseArgList(): Expr[] {
    const args: Expr[] = [];
    if (this.check('rparen')) return args;
    while (true) {
      args.push(this.parseAssignment());
      if (!this.match('comma')) break;
    }
    return args;
  }

  private parsePrimary(): Expr {
    const tok = this.peek();
    if (!tok) this.fail('expected an expression');

    if (tok.kind === 'intLiteral') {
      this.advance();
      return { kind: 'IntLit', value: Number(tok.text), line: tok.line, col: tok.col };
    }
    if (tok.kind === 'stringLiteral') {
      this.advance();
      return { kind: 'StrLit', value: tok.text, line: tok.line, col: tok.col };
    }
    if (tok.kind === 'identifier') {
      this.advance();
      return { kind: 'Ident', name: tok.text, line: tok.line, col: tok.col };
    }
    if (tok.kind === 'keyword' && tok.text === 'true') {
      this.advance();
      return { kind: 'IntLit', value: 1, line: tok.line, col: tok.col };
    }
    if (tok.kind === 'keyword' && tok.text === 'false') {
      this.advance();
      return { kind: 'IntLit', value: 0, line: tok.line, col: tok.col };
    }
    if (tok.kind === 'lparen') {
      this.advance();
      // Paren nesting is bounded by depth guard #1 in parseUnary:
      // parseAssignment below re-enters the descent chain, which passes back
      // through parseUnary for this level, so a counter here would be
      // redundant.
      const inner = this.parseAssignment();
      if (this.check('comma')) this.fail(this.commaOperatorMessage());
      this.expectPunct('rparen', ')', 'to close the parenthesized expression');
      return inner;
    }
    if (tok.kind === 'keyword' && REJECTED_KEYWORDS.has(tok.text)) {
      this.fail(this.reservedKeywordMessage(tok.text));
    }
    this.fail('expected an expression');
  }

  // ---- token-stream primitives ----
  // No EOF sentinel is ever appended to the token array (the lexer contract).
  // Every lookahead here goes through peek()/peekAt(), which
  // return undefined past the end instead of indexing out of bounds.

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private peekAt(offset: number): Token | undefined {
    return this.tokens[this.pos + offset];
  }

  private lastToken(): Token | undefined {
    return this.tokens[this.tokens.length - 1];
  }

  private atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  private advance(): Token {
    const tok = this.tokens[this.pos];
    if (!this.atEnd()) this.pos++;
    return tok;
  }

  private check(kind: TokenKind): boolean {
    return this.peek()?.kind === kind;
  }

  private checkKeyword(word: string): boolean {
    const tok = this.peek();
    return tok?.kind === 'keyword' && tok.text === word;
  }

  private match(kind: TokenKind): Token | null {
    if (!this.check(kind)) return null;
    return this.advance();
  }

  private matchKeyword(word: string): Token | null {
    if (!this.checkKeyword(word)) return null;
    return this.advance();
  }

  private expectKeyword(word: string, context: string): Token {
    const tok = this.matchKeyword(word);
    if (tok) return tok;
    return this.fail(`expected '${word}' ${context}`);
  }

  private expectPunct(kind: TokenKind, symbol: string, context: string): Token {
    const tok = this.match(kind);
    if (tok) return tok;
    return this.fail(`expected '${symbol}' ${context}`);
  }

  private expectIdentifier(context: string): Token {
    const tok = this.match('identifier');
    if (tok) return tok;
    return this.fail(`expected a name ${context}`);
  }

  private expectOrdinaryIdentifier(context: string): Token {
    const tok = this.expectIdentifier(context);
    this.rejectTypedefNameShadow(tok);
    return tok;
  }

  private rejectTypedefNameShadow(tok: Token): void {
    if (!this.typedefNames.has(tok.text)) return;
    this.diagnostics.push({
      line: tok.line,
      col: tok.col,
      message: TYPEDEF_NAME_SHADOWING.message,
      severity: 'error',
    });
  }

  private reservedKeywordMessage(word: string): string {
    return keywordFeatureMessage(word);
  }

  private commaOperatorMessage(): string {
    return 'the comma operator is not supported — commas are only used to separate declarations or call arguments';
  }

  // A declaration is only a block-item (inside `{ ... }`) or a top-level
  // declaration — never the single controlled statement of an unbraced
  // if/else/while/for/do. parseStatement reaches a declaration token ONLY
  // from those controlled-statement slots (parseStmtList splices in-block
  // declarations itself, before ever calling parseStatement), so hitting one
  // here is always this error.
  private declAsControlledStatementMessage(): string {
    return "a declaration can't be the body of an if, while, or for — wrap it in braces { }";
  }

  private rejectVariadicEllipsis(): void {
    if (this.check('dot') && this.peekAt(1)?.kind === 'dot' && this.peekAt(2)?.kind === 'dot') {
      this.fail(VARIADIC.message);
    }
  }

  private errorPos(): { line: number; col: number } {
    const tok = this.peek() ?? this.previous();
    return tok ? { line: tok.line, col: tok.col } : { line: 1, col: 1 };
  }

  private previous(): Token | undefined {
    return this.tokens[this.pos - 1];
  }

  private fail(message: string): never {
    const { line, col } = this.errorPos();
    this.diagnostics.push({ line, col, message, severity: 'error' });
    throw new ParseError(message);
  }

  private failAt(tok: Token, message: string, synchronized = false): never {
    this.diagnostics.push({ line: tok.line, col: tok.col, message, severity: 'error' });
    throw new ParseError(message, synchronized);
  }

  // Skips to and consumes the next ';', so the caller can resume parsing
  // statements/declarations after it. `stop` is the same predicate the
  // calling loop (parseStmtList) tests to decide it's done — passing it
  // through means synchronize() stops AT (does not consume) whatever token
  // that loop already treats as its own terminator ('}' for a block; '}',
  // 'case', or 'default' for a switch case), leaving it for the enclosing
  // parseStmtList/parseSwitch to consume, instead of blowing through a
  // scope boundary. Consuming it here (the pre-fix bug) blows through
  // scope: a block's own closing brace gets eaten, cascading into a bogus
  // "expected '}'" from the caller, and a switch's 'case'/'default' label
  // gets silently skipped, deleting that case and reattaching its
  // statements to the previous one.
  //
  // `stop` must always be a condition the immediate caller's own loop will
  // also exit on — anything looser risks an infinite loop (synchronize
  // refuses to advance past a token nobody is left to consume). parseBlock
  // and parseCaseStmts each pass their own loop's exact stop predicate, so
  // this always holds. parseProgram's catch calls this with no predicate
  // at all: there's no enclosing block/switch there, so it always sweeps
  // through to the next ';' (or end of input) instead of stopping.
  private synchronize(stop?: () => boolean): void {
    while (true) {
      const tok = this.peek();
      if (!tok) return;
      if (stop?.()) return;
      this.advance();
      if (tok.kind === 'semicolon') return;
    }
  }

  getDiagnostics(): CcDiagnostic[] {
    return this.diagnostics;
  }
}

export function parse(tokens: Token[]): { program: Program; diagnostics: CcDiagnostic[] } {
  const parser = new Parser(tokens);
  const program = parser.parseProgram();
  return { program, diagnostics: parser.getDiagnostics() };
}

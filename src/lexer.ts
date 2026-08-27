import type { CcDiagnostic } from './diagnostics.js';
import {
  INT16_MAX,
  isInInt16Range,
  MalformedIntLiteralError,
  parseIntLiteral,
  wrapTo16Signed,
} from './int16.js';
import { KEYWORDS, PUNCTUATORS, type Token, type TokenKind } from './tokens.js';

const MAX_MACRO_DEPTH = 16;

// MAX_MACRO_DEPTH limits nesting but does not bound total expansion work.
// A chain within that depth can expand each token to several references of
// the next and multiply token count exponentially before the depth cap fires.
// The token budget below is compilation-wide: it is a running
// total across every macro expansion in the source, not reset per invocation.
// A per-invocation cap is insufficient because a modest expansion can be
// referenced repeatedly and consume unbounded memory across the file.
// Crossing this budget aborts lexing with one named diagnostic before parse,
// checking, or code generation allocate for the expanded stream. 131072 is
// 2^17, large enough for ordinary source while bounding pathological growth.
// Both the depth and total-token limits are required.
const MAX_TOTAL_EXPANSION_TOKENS = 131072;

// The named single-character escapes of Appendix D Table D.1, each mapped to
// its character code. `\0` (null) and the numeric octal/hex forms are handled
// in resolveEscape, not here.
const ESCAPES: Record<string, string> = {
  n: '\n', // newline (10)
  t: '\t', // horizontal tab (9)
  v: '\v', // vertical tab (11)
  b: '\b', // backspace (8)
  r: '\r', // carriage return (13)
  f: '\f', // formfeed (12)
  a: '\x07', // audible alert / bell (7) — no JS shorthand
  '\\': '\\', // backslash (92)
  '?': '?', // question mark (63)
  "'": "'", // single quote (39)
  '"': '"', // double quote (34)
};

function isOctalDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '7';
}

class Lexer {
  private pos = 0;
  private line = 1;
  private col = 1;
  private startOfLine = true;
  private tokens: Token[] = [];
  private diagnostics: CcDiagnostic[] = [];
  // NULL is predefined, not lexed from a header: #include is accepted and
  // ignored (there is no stddef.h on disk), so without this the book's own
  // null-pointer idiom (16.2.4) fails with an undeclared-identifier error.
  // It is an ordinary object-like macro, not a keyword, so a program that
  // spells out `#define NULL 0` itself simply redefines it to the same
  // thing, and neither form is an error.
  private macros = new Map<string, Token[]>([
    ['NULL', [{ kind: 'intLiteral', text: '0', line: 0, col: 0 }]],
  ]);
  // Compilation-wide running total of tokens produced by macro expansion, and
  // the latch set once MAX_TOTAL_EXPANSION_TOKENS is crossed.
  private expansionTokens = 0;
  private expansionBudgetHit = false;

  constructor(private readonly src: string) {}

  run(): { tokens: Token[]; diagnostics: CcDiagnostic[] } {
    while (!this.atEnd()) {
      // Once the compilation-wide expansion budget is spent, stop: the program
      // is doomed (ok:false), and one clean diagnostic beats a cascade of
      // spurious parse errors over the leftover expansion tokens.
      if (this.expansionBudgetHit) break;
      const ch = this.peek()!;
      if (ch === '\n') {
        this.advance();
        this.startOfLine = true;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.advance();
        continue;
      }
      if (ch === '/' && this.peekAt(1) === '/') {
        this.skipLineComment();
        continue;
      }
      if (ch === '/' && this.peekAt(1) === '*') {
        this.skipBlockComment();
        this.startOfLine = false;
        continue;
      }
      if (ch === '#' && this.startOfLine) {
        this.handleDirective();
        this.startOfLine = false;
        continue;
      }
      this.startOfLine = false;
      const tok = this.scanOneToken();
      if (tok) this.emit(tok);
    }
    return { tokens: this.tokens, diagnostics: this.diagnostics };
  }

  private emit(tok: Token): void {
    if (tok.kind === 'identifier' && this.macros.has(tok.text)) {
      // Iterative append (not `this.tokens.push(...expanded)`): a spread
      // call's argument count is bounded by the engine, and the whole point
      // of the budget below is that a pathological expansion could still
      // produce a huge array right up to that budget.
      for (const t of this.expandMacro(tok.text, tok.line, tok.col)) this.tokens.push(t);
    } else {
      this.tokens.push(tok);
    }
  }

  private expandMacro(name: string, line: number, col: number): Token[] {
    let capHit = false;
    const acc: Token[] = [];
    const expand = (macroName: string, depth: number): void => {
      if (capHit) return;
      if (depth > MAX_MACRO_DEPTH) {
        capHit = true;
        this.err(
          line,
          col,
          `macro '${macroName}' exceeded the maximum expansion depth (${MAX_MACRO_DEPTH}) — check for a self-referential #define`,
        );
        return;
      }
      const body = this.macros.get(macroName)!;
      for (const t of body) {
        if (capHit) return;
        if (t.kind === 'identifier' && this.macros.has(t.text)) {
          expand(t.text, depth + 1);
          continue;
        }
        // Compilation-wide count (this.expansionTokens), NOT a per-invocation
        // local — see MAX_TOTAL_EXPANSION_TOKENS. Once crossed, latch the
        // budget-hit flag so run() stops after this expansion returns.
        this.expansionTokens++;
        if (this.expansionTokens > MAX_TOTAL_EXPANSION_TOKENS) {
          capHit = true;
          this.expansionBudgetHit = true;
          this.err(
            line,
            col,
            `macro expansion exceeded the ${MAX_TOTAL_EXPANSION_TOKENS}-token compilation budget (is a macro self-referential or combinatorial?)`,
          );
          return;
        }
        // Append directly to the shared accumulator (not a per-level array
        // later spread into the caller) — the whole expansion, across every
        // recursion level, grows this ONE array, so the budget check above
        // is a true running total, and nothing ever spreads a large array
        // into a function call.
        acc.push({ ...t, line, col });
      }
    };
    expand(name, 1);
    return acc;
  }

  private handleDirective(): void {
    const startLine = this.line;
    const startCol = this.col;
    const lineStartPos = this.pos;
    while (!this.atEnd() && this.peek() !== '\n') this.advance();
    const lineEndPos = this.pos;
    const lineEndLine = this.line;
    const lineEndCol = this.col;
    const text = this.src.slice(lineStartPos, lineEndPos);
    this.processDirective(text, startLine, startCol, lineStartPos, lineEndPos);
    this.pos = lineEndPos;
    this.line = lineEndLine;
    this.col = lineEndCol;
  }

  private processDirective(
    text: string,
    startLine: number,
    startCol: number,
    lineStartPos: number,
    lineEndPos: number,
  ): void {
    const includeMatch = text.match(/^#\s*include\b(.*)$/);
    if (includeMatch) {
      // Only <file>-style and "file"-style operands are accepted. A bare
      // `#include` or bare-word operand is malformed, so validation produces
      // one named rejection instead of treating the directive as a no-op.
      // A trailing // comment is stripped first, matching how #define
      // operands are scanned.
      const operand = includeMatch[1].replace(/\/\/.*$/, '').trim();
      if (/^<[^>]*>$/.test(operand) || /^"[^"]*"$/.test(operand)) return;
      this.err(startLine, startCol, '#include expects <stdio.h>-style or "file"-style operand');
      return;
    }

    const defineMatch = text.match(/^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (defineMatch) {
      const name = defineMatch[1];
      const afterName = defineMatch[0].length;
      if (text[afterName] === '(') {
        this.err(
          startLine,
          startCol,
          'function-like macros are not in the supported subset — use a plain #define NAME value',
        );
        return;
      }
      this.recordMacro(name, lineStartPos + afterName, startLine, startCol + afterName, lineEndPos);
      return;
    }

    const word = text.match(/^#\s*([A-Za-z_]+)/)?.[1];
    const label = word ? `#${word}` : 'this preprocessor directive';
    this.err(
      startLine,
      startCol,
      `${label} is not in the supported subset — only #include and #define are supported`,
    );
  }

  private recordMacro(
    name: string,
    valueStartPos: number,
    line: number,
    col: number,
    lineEndPos: number,
  ): void {
    this.pos = valueStartPos;
    this.line = line;
    this.col = col;
    const body: Token[] = [];
    while (this.pos < lineEndPos) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.advance();
        continue;
      }
      if (ch === '/' && this.peekAt(1) === '/') break;
      const tok = this.scanOneToken();
      if (tok) body.push(tok);
    }
    this.macros.set(name, body);
  }

  private scanOneToken(): Token | null {
    const ch = this.peek();
    if (ch === undefined) return null;
    if (/[A-Za-z_]/.test(ch)) return this.scanIdentifierOrKeyword();
    if (/[0-9]/.test(ch)) return this.scanNumber();
    if (ch === "'") return this.scanChar();
    if (ch === '"') return this.scanString();
    const punct = this.matchPunctuator();
    if (punct) return punct;
    const startLine = this.line;
    const startCol = this.col;
    this.advance();
    this.err(startLine, startCol, `'${ch}' is not a recognized character`);
    return null;
  }

  private scanIdentifierOrKeyword(): Token {
    const startLine = this.line;
    const startCol = this.col;
    let text = '';
    while (!this.atEnd() && /[A-Za-z0-9_]/.test(this.peek()!)) {
      text += this.peek();
      this.advance();
    }
    const kind: TokenKind = KEYWORDS.has(text) ? 'keyword' : 'identifier';
    return { kind, text, line: startLine, col: startCol };
  }

  private scanNumber(): Token | null {
    const startLine = this.line;
    const startCol = this.col;
    const rawStart = this.pos;
    const isHex = this.peek() === '0' && (this.peekAt(1) === 'x' || this.peekAt(1) === 'X');
    if (isHex) {
      this.advance();
      this.advance();
      while (!this.atEnd() && /[0-9a-fA-F]/.test(this.peek()!)) this.advance();
    } else {
      while (!this.atEnd() && /[0-9]/.test(this.peek()!)) this.advance();
    }
    const raw = this.src.slice(rawStart, this.pos);
    if (!isHex && raw.length > 1 && raw[0] === '0') {
      this.err(
        startLine,
        startCol,
        'octal literals are not in the supported subset — write the decimal value',
      );
      return null;
    }
    let parsed;
    try {
      parsed = parseIntLiteral(raw);
    } catch (e) {
      if (e instanceof MalformedIntLiteralError) {
        this.err(startLine, startCol, e.message);
        return null;
      }
      throw e;
    }
    const wrapped = wrapTo16Signed(parsed.value);
    if (!isInInt16Range(parsed.value)) {
      // Describe the LITERAL's own reduction, not the final expression value:
      // the lexer sees only this token, so for `-100000` (unary minus applied
      // by the parser afterward) it must not claim the surrounding expression's
      // signed result. "reduced to its low 16 bits (V)" is true for the literal
      // token regardless of any operator that later transforms it.
      this.warn(
        startLine,
        startCol,
        `the literal ${raw} does not fit in 16 bits; it is reduced to its low 16 bits (${wrapped})`,
      );
    } else if (
      parsed.radix === 10 &&
      parsed.value > BigInt(INT16_MAX) &&
      !(parsed.value === BigInt(INT16_MAX) + 1n && this.precededByUnaryMinus())
    ) {
      // A DECIMAL literal in [32768, 65535] fits the 16-bit
      // word but exceeds int's signed maximum, so it reads back negative. A
      // hex spelling of the top half of the word is obviously a bit pattern
      // and stays silent (handled by the guard above); a plain decimal almost
      // certainly meant a positive value it cannot hold, so warn with the
      // exact wrapped value it reads back as.
      //
      // The one exception is `-32768`, the idiomatic INT_MIN. There the
      // literal 32768 is the operand of a UNARY minus, and -32768 is exactly
      // int's minimum — nothing wrapped unexpectedly, so warning is noise. A
      // BINARY minus (`a - 32768`) keeps the warning: there 32768 really does
      // read back as -32768 and change the arithmetic.
      this.warn(
        startLine,
        startCol,
        `decimal literal ${raw} exceeds int's maximum ${INT16_MAX}; stored as the 16-bit pattern, it reads back as ${wrapped}`,
      );
    }
    return { kind: 'intLiteral', text: String(wrapped), line: startLine, col: startCol };
  }

  private scanChar(): Token | null {
    const startLine = this.line;
    const startCol = this.col;
    this.advance(); // opening '
    if (this.atEnd() || this.peek() === '\n') {
      this.err(startLine, startCol, "unterminated char literal — missing closing '");
      return null;
    }
    let value: number;
    if (this.peek() === '\\') {
      this.advance();
      const resolved = this.resolveEscape(startLine, startCol, "'");
      if (resolved === null) return null;
      value = resolved.charCodeAt(0);
    } else if (this.peek() === "'") {
      this.err(
        startLine,
        startCol,
        'a char literal needs exactly one character between the quotes',
      );
      this.advance();
      return null;
    } else {
      const cp = this.src.codePointAt(this.pos)!;
      if (cp > 0x7f) {
        this.reportNonAscii('char', cp);
        // Recover to the delimiter so a following token scans cleanly.
        while (!this.atEnd() && this.peek() !== '\n' && this.peek() !== "'") this.advance();
        if (this.peek() === "'") this.advance();
        return null;
      }
      value = this.peek()!.charCodeAt(0);
      this.advance();
    }
    if (this.peek() !== "'") {
      // 'ab' HAS a closing quote — the problem is the character
      // count, and "unterminated" points the student at the wrong thing.
      // Scan to the line end: a ' found on the way means over-long (recover
      // past it); no ' means genuinely unterminated.
      let sawClose = false;
      while (!this.atEnd() && this.peek() !== '\n') {
        const ch = this.peek();
        this.advance();
        if (ch === "'") {
          sawClose = true;
          break;
        }
      }
      this.err(
        startLine,
        startCol,
        sawClose
          ? 'a char literal needs exactly one character between the quotes'
          : "unterminated char literal — missing closing '",
      );
      return null;
    }
    this.advance(); // closing '
    return { kind: 'intLiteral', text: String(value), line: startLine, col: startCol };
  }

  private scanString(): Token | null {
    const startLine = this.line;
    const startCol = this.col;
    this.advance(); // opening "
    let out = '';
    while (true) {
      if (this.atEnd() || this.peek() === '\n') {
        this.err(startLine, startCol, 'unterminated string literal — missing closing "');
        return null;
      }
      const ch = this.peek()!;
      if (ch === '"') {
        this.advance();
        break;
      }
      if (ch === '\\') {
        this.advance();
        const resolved = this.resolveEscape(startLine, startCol, '"');
        if (resolved === null) return null;
        out += resolved;
        continue;
      }
      const cp = this.src.codePointAt(this.pos)!;
      if (cp > 0x7f) {
        this.reportNonAscii('string', cp);
        this.advance();
        if (cp > 0xffff) this.advance(); // skip the low surrogate half too
        continue;
      }
      out += ch;
      this.advance();
    }
    return { kind: 'stringLiteral', text: out, line: startLine, col: startCol };
  }

  // LC-3 stores zero-extended 7-bit ASCII, one character per
  // word (Ch 7 section 7.2.2.4), so any source character above U+007F in a
  // string/char literal is rejected by name. `src` is indexed by UTF-16 code
  // unit, but codePointAt combines a surrogate pair, so an astral character is
  // reported by its true code point (e.g. U+1F600), not a surrogate half. The
  // diagnostic points at the offending character. Comments stay unrestricted.
  private reportNonAscii(context: 'string' | 'char', cp: number): void {
    const hex = cp.toString(16).toUpperCase().padStart(4, '0');
    this.err(
      this.line,
      this.col,
      `non-ASCII character U+${hex} in ${context} literal — LC-3 strings are ASCII, one 7-bit character per word (Ch 7 section 7.2.2.4)`,
    );
  }

  private resolveEscape(startLine: number, startCol: number, closingQuote: string): string | null {
    const esc = this.peek();
    if (esc === undefined || esc === '\n') {
      const what = closingQuote === "'" ? 'char' : 'string';
      this.err(
        startLine,
        startCol,
        `unterminated ${what} literal — missing closing ${closingQuote}`,
      );
      return null;
    }

    // Table D.1's hex numeric form (\xNN) is outside this subset. Reject it
    // by name rather than silently mis-reading it. The
    // hex digits are consumed so scanning recovers cleanly at the delimiter.
    if (esc === 'x' || esc === 'X') {
      this.advance();
      while (!this.atEnd() && /[0-9a-fA-F]/.test(this.peek()!)) this.advance();
      this.err(
        startLine,
        startCol,
        "hex escapes like '\\x41' aren't in the subset yet — use a named escape (\\n \\t \\r \\v \\b \\f \\a) or write the character directly",
      );
      return '\0';
    }

    // Octal: bare '\0' is the null character (heavily used as a terminator),
    // but any longer octal run (\0NN) or a nonzero leading digit (\1..\7) is
    // Table D.1's octal numeric form is outside this subset and is rejected by
    // name so '\012' is never silently taken as the newline it denotes in C.
    if (isOctalDigit(esc)) {
      if (esc === '0' && !isOctalDigit(this.peekAt(1))) {
        this.advance();
        return '\0';
      }
      this.advance();
      while (!this.atEnd() && isOctalDigit(this.peek())) this.advance();
      this.err(
        startLine,
        startCol,
        "octal escapes like '\\012' aren't in the subset yet — use a named escape (\\n \\t \\r \\v \\b \\f \\a) or write the character directly; '\\0' alone is the null character",
      );
      return '\0';
    }

    const resolved = ESCAPES[esc];
    this.advance();
    if (resolved === undefined) {
      this.err(startLine, startCol, `the escape '\\${esc}' is not recognized`);
      return esc;
    }
    return resolved;
  }

  private matchPunctuator(): Token | null {
    const startLine = this.line;
    const startCol = this.col;
    for (const [str, kind] of PUNCTUATORS) {
      if (this.src.startsWith(str, this.pos)) {
        for (let i = 0; i < str.length; i++) this.advance();
        return { kind, text: str, line: startLine, col: startCol };
      }
    }
    return null;
  }

  private skipLineComment(): void {
    while (!this.atEnd() && this.peek() !== '\n') this.advance();
  }

  private skipBlockComment(): void {
    const startLine = this.line;
    const startCol = this.col;
    this.err(
      startLine,
      startCol,
      'block comments are not in the supported subset — use // line comments',
    );
    this.advance();
    this.advance();
    while (!this.atEnd() && !(this.peek() === '*' && this.peekAt(1) === '/')) this.advance();
    if (!this.atEnd()) {
      this.advance();
      this.advance();
    }
  }

  private atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  private peek(): string | undefined {
    return this.src[this.pos];
  }

  private peekAt(offset: number): string | undefined {
    return this.src[this.pos + offset];
  }

  private advance(): void {
    const ch = this.src[this.pos];
    this.pos++;
    if (ch === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
  }

  private err(line: number, col: number, message: string): void {
    this.diagnostics.push({ line, col, message, severity: 'error' });
  }

  private warn(line: number, col: number, message: string): void {
    this.diagnostics.push({ line, col, message, severity: 'warning' });
  }

  // The token being scanned is not yet pushed, so tokens.at(-1) is the
  // token immediately before it. A '-' there is a unary minus (rather than
  // subtraction) when what precedes IT is not a value — i.e. nothing, an
  // operator, or an opening bracket/comma. That is exactly the `-32768` INT_MIN
  // shape the warning should stay quiet about.
  private precededByUnaryMinus(): boolean {
    const prev = this.tokens.at(-1);
    if (!prev || prev.kind !== 'minus') return false;
    const before = this.tokens.at(-2);
    if (!before) return true; // leading -32768
    // A value ends with a literal, identifier, or a closing paren; a minus
    // after any of those is binary subtraction. Anything else makes it unary.
    return !(
      before.kind === 'intLiteral' ||
      before.kind === 'identifier' ||
      before.kind === 'rparen'
    );
  }
}

export function lex(source: string): { tokens: Token[]; diagnostics: CcDiagnostic[] } {
  return new Lexer(source.replace(/\r\n?/g, '\n')).run();
}

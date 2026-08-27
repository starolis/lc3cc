// The compiler's single definition of 16-bit LC-3 word arithmetic
// (Appendix A) is pure, dependency-free, and deliberately small. Codegen's
// constant pool, check.ts's constant folding, and the lexer's literal scanner
// all consume these helpers. Literal parsing uses BigInt so precision is
// preserved before the explicit range policy wraps a value to one word.
// Keeping these operations together ensures compile-time and emitted runtime
// behavior agree without tying the surface to any one caller's shape.

export const INT16_MIN = -32768;
export const INT16_MAX = 32767;
const MODULUS = 65536n; // 2**16

export interface ParsedIntLiteral {
  value: bigint;
  radix: 10 | 16;
}

// Thrown by parseIntLiteral for text that isn't a well-formed literal at
// all (currently: a `0x`/`0X` radix prefix with no digits after it). This
// is a distinct failure from "value out of range" — that's not an error,
// it's wrapped (see isInInt16Range / wrapTo16Signed below).
export class MalformedIntLiteralError extends Error {}

// Parse a decimal or 0x-hex literal's exact source text with BigInt, so an
// arbitrarily long run of digits (e.g. 400 of them) never loses precision
// or produces Infinity/NaN the way `Number(text)` would. Callers decide
// the range policy on the returned arbitrary-precision `value`.
export function parseIntLiteral(raw: string): ParsedIntLiteral {
  if (raw[0] === '0' && (raw[1] === 'x' || raw[1] === 'X')) {
    const digits = raw.slice(2);
    if (digits === '') {
      throw new MalformedIntLiteralError('a hexadecimal literal needs at least one digit after 0x');
    }
    return { value: BigInt(`0x${digits}`), radix: 16 };
  }
  if (raw === '') {
    throw new MalformedIntLiteralError('expected a digit');
  }
  return { value: BigInt(raw), radix: 10 };
}

// Whether `value` fits in a 16-bit word without wrapping, under the
// compiler's literal policy: accept both the signed view (-32768..32767) and the
// "unsigned-looking" spellings a student writes for the top half of the
// word (32768..65535, e.g. 0xFFFF or plain decimal 65535) — those are
// obviously meant as a 16-bit bit pattern, not a request to wrap something
// huge. Anything outside [-32768, 65535] is genuinely out of range and
// gets wrapped (with a warning) by the caller. Applied uniformly regardless
// of radix, so decimal and hex agree.
export function isInInt16Range(value: bigint): boolean {
  return value >= -32768n && value <= 65535n;
}

// Wrap an arbitrary integer to the signed 16-bit range [-32768, 32767],
// matching how LC-3 hardware truncates any wider result to a word. The
// bigint path never produces NaN/Infinity, however large the input —
// unlike Number arithmetic, BigInt modulo has no magnitude limit. The
// number path uses the same modulo formula and therefore preserves
// exact behavior across number and bigint inputs.
export function wrapTo16Signed(value: bigint | number): number {
  if (typeof value === 'bigint') {
    let wrapped = value % MODULUS;
    if (wrapped < 0n) wrapped += MODULUS;
    return Number(wrapped >= 32768n ? wrapped - MODULUS : wrapped);
  }
  const wrapped = ((value % 65536) + 65536) % 65536;
  return wrapped >= 32768 ? wrapped - 65536 : wrapped;
}

// Left and right shift computed EXACTLY the way the emitted lowering computes
// them (codegen.ts's emitShiftLeftCombine / emitShiftRightCombine), so a shift
// has the SAME result whether it is constant-folded here or run
// on the target machine. The LC-3 ISA has no shift
// instruction (Appendix A); the C subset lowers a shift to a counted loop, and
// these helpers are the single source of truth for that loop's arithmetic.
//
// Both follow the emitted loop's count guard literally: the loop tests the
// count and stops on count <= 0, so a count of 0 or below leaves the value
// unchanged. Each iteration operates once, in 16-bit signed space, so a count
// of 16 or more drives the value to 0 (<<) or full sign-fill 0/-1 (>>). C
// leaves shifts by the width or more (and negative counts) undefined; the
// checker rejects any CONSTANT count outside 0..15, so those extremes are only
// reachable from a runtime (non-constant) count, whose documented behavior is
// exactly this loop.
export function shiftLeft16(value: number, count: number): number {
  let v = wrapTo16Signed(value);
  for (let i = 0; i < count; i++) {
    v = wrapTo16Signed(v + v);
  }
  return v;
}

export function shiftRight16(value: number, count: number): number {
  let v = wrapTo16Signed(value);
  for (let i = 0; i < count; i++) {
    v = wrapTo16Signed(v >> 1); // v is in [-32768,32767], so JS >> is the arithmetic 1-bit shift
  }
  return v;
}

export type ComparisonOp = '<' | '<=' | '>' | '>=' | '==' | '!=';

// Fold a relational/equality comparison the way the EMITTED code computes it,
// so a comparison has the SAME result whether it is constant-folded or run
// on the target machine. C relational operators order operands by their
// mathematical int value (Ch 12 section 12.3.6, Appendix D section D.5.5).
//
// A naive `left - right` two's-complement subtract, read off the difference's
// condition codes, is only a valid comparison when the difference fits in a
// 16-bit word — Fig 13.7's subtraction shortcut is safe for its bounded
// example but overflows on a general pair (e.g. -20000 - 20000 = -40000 wraps
// to +25536, whose sign bit is 0). So compare16 sign-splits:
//   - When left and right have different signs, the negative operand is the
//     smaller one; decide directly from the sign bits, no subtraction.
//   - When their signs match, `left - right` stays within [-32767, 32767]
//     (two same-sign 16-bit values differ by at most 32767 — the widest gap
//     within [0, 32767] or within [-32768, -1] is 32767 — so the difference
//     cannot leave the signed range [-32768, 32767]), so the subtract cannot
//     overflow and the difference's sign/zero is exact.
//   - == / != always use the wrapped difference: it is zero iff the operands
//     are equal, which is safe regardless of overflow.
//
// emitCompareCombine emits this identical algorithm; keep this the ONE place
// the 16-bit comparison semantics live.
export function compare16(op: ComparisonOp, left: number, right: number): 0 | 1 {
  const l = wrapTo16Signed(left);
  const r = wrapTo16Signed(right);
  if (op === '==') return wrapTo16Signed(l - r) === 0 ? 1 : 0;
  if (op === '!=') return wrapTo16Signed(l - r) !== 0 ? 1 : 0;
  if (l < 0 !== r < 0) {
    // Signs differ: left is smaller exactly when it is the negative operand.
    const leftSmaller = l < 0;
    const trueWhenLeftSmaller = op === '<' || op === '<=';
    return leftSmaller === trueWhenLeftSmaller ? 1 : 0;
  }
  const diff = wrapTo16Signed(l - r); // same-sign: cannot overflow
  switch (op) {
    case '<':
      return diff < 0 ? 1 : 0;
    case '<=':
      return diff <= 0 ? 1 : 0;
    case '>':
      return diff > 0 ? 1 : 0;
    case '>=':
      return diff >= 0 ? 1 : 0;
  }
}

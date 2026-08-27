export type TokenKind =
  | 'identifier'
  | 'intLiteral'
  | 'stringLiteral'
  | 'keyword'
  | 'plus'
  | 'minus'
  | 'star'
  | 'slash'
  | 'percent'
  | 'amp'
  | 'pipe'
  | 'caret'
  | 'tilde'
  | 'shl'
  | 'shr'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'eqeq'
  | 'ne'
  | 'not'
  | 'andand'
  | 'oror'
  | 'plusplus'
  | 'minusminus'
  | 'assign'
  | 'pluseq'
  | 'minuseq'
  | 'stareq'
  | 'slasheq'
  | 'percenteq'
  | 'ampeq'
  | 'pipeeq'
  | 'careteq'
  | 'shleq'
  | 'shreq'
  | 'question'
  | 'colon'
  | 'lparen'
  | 'rparen'
  | 'lbrace'
  | 'rbrace'
  | 'lbracket'
  | 'rbracket'
  | 'dot'
  | 'arrow'
  | 'comma'
  | 'semicolon';

export interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  col: number;
}

// Punctuators ordered longest-first within each shared prefix so a linear
// startsWith scan always finds the maximal match (e.g. <<= before << before <).
export const PUNCTUATORS: ReadonlyArray<readonly [string, TokenKind]> = [
  ['<<=', 'shleq'],
  ['>>=', 'shreq'],
  ['<<', 'shl'],
  ['>>', 'shr'],
  ['<=', 'le'],
  ['>=', 'ge'],
  ['==', 'eqeq'],
  ['!=', 'ne'],
  ['&&', 'andand'],
  ['||', 'oror'],
  ['++', 'plusplus'],
  ['--', 'minusminus'],
  ['+=', 'pluseq'],
  ['-=', 'minuseq'],
  ['*=', 'stareq'],
  ['/=', 'slasheq'],
  ['%=', 'percenteq'],
  ['&=', 'ampeq'],
  ['|=', 'pipeeq'],
  ['^=', 'careteq'],
  ['->', 'arrow'],
  ['<', 'lt'],
  ['>', 'gt'],
  ['=', 'assign'],
  ['!', 'not'],
  ['+', 'plus'],
  ['-', 'minus'],
  ['*', 'star'],
  ['/', 'slash'],
  ['%', 'percent'],
  ['&', 'amp'],
  ['|', 'pipe'],
  ['^', 'caret'],
  ['~', 'tilde'],
  ['?', 'question'],
  [':', 'colon'],
  ['(', 'lparen'],
  [')', 'rparen'],
  ['{', 'lbrace'],
  ['}', 'rbrace'],
  ['[', 'lbracket'],
  [']', 'rbracket'],
  ['.', 'dot'],
  [',', 'comma'],
  [';', 'semicolon'],
];

// Keywords accepted by the supported C subset.
export const SUPPORTED_KEYWORDS = new Set([
  'int',
  'char',
  'bool',
  // `_Bool` is standard C's spelling of the boolean type (Ch 12 section
  // 12.2.1); this subset accepts it as the same type as stdbool.h's `bool`.
  '_Bool',
  'void',
  'if',
  'else',
  'while',
  'for',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'return',
  'const',
  'struct',
  'typedef',
  'sizeof',
  'true',
  'false',
]);

// Real C keywords outside the supported subset. Lexed as 'keyword' (not
// 'identifier') so the checker can name them in a rejection diagnostic.
export const REJECTED_KEYWORDS = new Set([
  'float',
  'double',
  'long',
  'short',
  'unsigned',
  'signed',
  'union',
  'enum',
  'goto',
  'static',
  'extern',
  'auto',
  'register',
  'volatile',
]);

export const KEYWORDS = new Set([...SUPPORTED_KEYWORDS, ...REJECTED_KEYWORDS]);

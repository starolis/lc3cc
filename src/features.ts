// Single source of truth for every feature this compiler does not currently
// support, so a diagnostic's scope claim can never drift out of sync with
// the documented subset classification. This file mirrors that classification
// rather than inventing its own. Every "not
// supported" / "not in this subset" message the parser and checker emit — for a rejected
// keyword, a restricted struct/typedef/sizeof construct, a pointer/array form
// (an unspecified dimension, a brace initializer, a variable-length size,
// pointer subtraction or ordering), an unsupported scanf conversion, or a call
// to a known library function this subset doesn't implement — routes
// through here instead of being hand-written at the call site.
//
// Every live entry is `out-of-scope`, the machine-readable status for a
// construct outside the supported subset. Some boundaries may be relaxed
// additively, while deliberate exclusions remain closed. No entry promises
// when or whether a feature will land. Once a capability ships, its entry
// retires instead of preserving stale history. Messages describe only the
// compiler's current behavior and must not infer what any course, book, or
// teaching material covers. That keeps diagnostics accurate wherever the
// compiler is used.

export type FeatureStatus = 'out-of-scope';

export interface FeatureInfo {
  readonly feature: string;
  readonly status: FeatureStatus;
  readonly message: string;
}

// Student-facing messages name what the compiler DOES cover and point to the
// public subset page. They do not expose implementation history or internal
// planning labels.
const COVERS =
  'this compiler covers a C subset: int, char, and bool; pointers, arrays, strings, structs, typedefs, and sizeof; malloc and free; functions and the usual control flow';
const SEE_PAGE = 'see the C subset page for what is supported';

function outOfScope(feature: string, message: string): FeatureInfo {
  return { feature, status: 'out-of-scope', message };
}

// Reserved keywords from tokens.ts's REJECTED_KEYWORDS are classified by
// language category: types, control flow, or operators. They are out of the
// supported subset. `struct`, `typedef`, and `sizeof` are absent because their
// accepted syntax is implemented, with narrower rejected forms represented by
// dedicated entries below.
export const KEYWORD_FEATURES: Readonly<Record<string, FeatureInfo>> = {
  float: outOfScope(
    'float',
    `'float' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
  double: outOfScope(
    'double',
    `'double' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
  unsigned: outOfScope(
    'unsigned',
    `'unsigned' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
  long: outOfScope(
    'long',
    `'long' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
  short: outOfScope(
    'short',
    `'short' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
  signed: outOfScope(
    'signed',
    `'signed' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
  union: outOfScope(
    'union',
    `'union' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
  enum: outOfScope(
    'enum',
    `'enum' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
  goto: outOfScope(
    'goto',
    `'goto' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
  static: outOfScope(
    'static',
    `'static' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
  extern: outOfScope(
    'extern',
    `'extern' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
  auto: outOfScope(
    'auto',
    `'auto' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
  register: outOfScope(
    'register',
    `'register' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
  volatile: outOfScope(
    'volatile',
    `'volatile' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ),
};

// This subset deliberately supports only sizeof's parenthesized type-name form;
// the expression form has its own public boundary row.
export const SIZEOF_EXPRESSION: FeatureInfo = outOfScope(
  'sizeof-expression',
  `'sizeof' accepts a parenthesized type name, not an expression, in this C subset — write 'sizeof(int)' or 'sizeof(struct Tag)'. ${SEE_PAGE}.`,
);

// Falls back to a generic out-of-scope message for a keyword this table
// doesn't (yet) name explicitly, so adding a keyword to REJECTED_KEYWORDS
// without also adding it here never regresses to a blank message — it just
// loses the feature-specific copy until someone fills it in.
export function keywordFeatureMessage(word: string): string {
  const known = KEYWORD_FEATURES[word];
  if (known) return known.message;
  return outOfScope(
    word,
    `'${word}' is not part of the C subset this compiler covers — ${COVERS}. ${SEE_PAGE}.`,
  ).message;
}

// Pointer subtraction and pointer ordering are both rejected by this subset.
// Pointer equality/inequality is what the null-pointer idiom needs and remains
// supported.
export const POINTER_SUBTRACTION: FeatureInfo = outOfScope(
  'pointer-subtraction',
  `subtracting one pointer from another is not supported in the current v1 C subset. ${SEE_PAGE}.`,
);

export const POINTER_RELATIONAL: FeatureInfo = outOfScope(
  'pointer-relational',
  `pointers can be compared with '==' and '!=' but not ordered with '<' or '>'. ${SEE_PAGE}.`,
);

// A string literal pools to one shared, WRITABLE .STRINGZ per unique text,
// program-wide (poolString, codegen.ts) — reused by every occurrence of the
// same text, anywhere in the program. That is only safe where the literal is
// exclusively READ through: printf's/scanf's format argument. A char array's
// initializer is the other legal context: it COPIES the
// characters into the array's own storage (FnCtx.addLocalStringInit for a
// local, emitStringArrayGlobal for a global), never aliasing the shared pool,
// so a write through the array can never corrupt another identical literal
// elsewhere in the program. `char *s = "hello";` — a plain pointer aimed at
// the shared pool itself — stays rejected permanently: that is the one
// remaining shape this message covers. The diagnostic follows the capability
// and states only what the compiler accepts now: formats and copied char-array
// initializers are legal, while a pointer directly aliasing pooled string
// storage is not. Any future capability change must update this message
// in the same change so behavior and explanation remain aligned.
export const STRING_LITERAL_CONTEXT: FeatureInfo = outOfScope(
  'string-literal-context',
  `a string literal is legal only as the format argument of printf or scanf, or as the initializer of a char array, and nowhere else. ${SEE_PAGE}.`,
);

// These syntax boundaries are separate FeatureInfo entries so every
// parser rejection shares one clear sentence, the same public subset-page
// direction, and a dedicated classification.
export const BLOCK_SCOPE_TYPE_DECLARATION: FeatureInfo = outOfScope(
  'block-scope-type-declaration',
  `type declarations in this C subset belong at file scope — move the struct definition or typedef above the functions. ${SEE_PAGE}.`,
);

export const TAGLESS_STRUCT_TYPEDEF: FeatureInfo = outOfScope(
  'tagless-struct-typedef',
  `a typedef struct needs an explicit tag in this C subset — write 'typedef struct Tag { ... } Name;'. ${SEE_PAGE}.`,
);

export const BARE_STRUCT_FORWARD: FeatureInfo = outOfScope(
  'bare-struct-forward',
  `a bare struct tag declaration is not supported — write 'typedef struct Tag Name;' before defining the tagged struct. ${SEE_PAGE}.`,
);

export const STRUCT_MEMBER_ARRAY: FeatureInfo = outOfScope(
  'struct-member-array',
  `a struct member array needs exactly one fixed dimension in this subset — write 'member[N]' or use a pointer. ${SEE_PAGE}.`,
);

export const TYPEDEF_NAME_SHADOWING: FeatureInfo = outOfScope(
  'typedef-name-shadowing',
  `a variable, parameter, or function cannot reuse a typedef name in this subset — choose a different ordinary identifier. ${SEE_PAGE}.`,
);

// Semantic struct boundaries are separate entries so each construct receives
// its own public explanation.
export const STRUCT_ASSIGNMENT: FeatureInfo = outOfScope(
  'struct-assignment',
  `a whole struct cannot be assigned or initialized by value in this subset — assign its members one at a time, or use a pointer to the struct instead. ${SEE_PAGE}.`,
);

export const STRUCT_BY_VALUE_ARGUMENT: FeatureInfo = outOfScope(
  'struct-by-value-argument',
  `a struct cannot be passed to a function by value in this subset — pass a pointer to the struct instead. ${SEE_PAGE}.`,
);

export const STRUCT_RETURN: FeatureInfo = outOfScope(
  'struct-return',
  `a function cannot return a struct by value in this subset — return a pointer to the struct instead. ${SEE_PAGE}.`,
);

export const STRUCT_TYPED_MEMBER: FeatureInfo = outOfScope(
  'struct-typed-member',
  `a struct member cannot contain another struct by value in this subset — make the member a pointer to that struct instead. ${SEE_PAGE}.`,
);

// User-defined variadic functions ('...' in a parameter list) are deliberately
// outside the subset. printf remains available as a builtin with its fixed
// compiler-managed interface; that does not add general variadic declarations.
// The diagnostic names the '...' token the student wrote rather than reporting
// a generic type error.
export const VARIADIC: FeatureInfo = outOfScope(
  'variadic',
  `user-defined variadic functions ('...') are not part of the supported C subset. ${SEE_PAGE}.`,
);

// A `[]` with no size, outside a parameter's leading dimension. Every other
// array declaration needs a compile-time size.
export const UNSPECIFIED_ARRAY_DIMENSION: FeatureInfo = outOfScope(
  'unspecified-array-dimension',
  `an array needs a size in brackets, except for the first dimension of a function parameter. ${SEE_PAGE}.`,
);

export const ARRAY_BRACE_INIT: FeatureInfo = outOfScope(
  'array-brace-initializer',
  `a brace { } initializer is not supported — initialize a scalar with one expression, assign array elements or struct members one at a time, or initialize a char array from a string literal. ${SEE_PAGE}.`,
);

// malloc provides runtime-sized storage in this subset, while variable-length
// arrays remain unsupported. This boundary can be relaxed additively later,
// but the diagnostic describes only the current compile-time-size
// requirement and the supported malloc alternative.
export const VARIABLE_LENGTH_ARRAY: FeatureInfo = outOfScope(
  'variable-length-array',
  `an array size must be known at compile time — use a literal or a #define, or allocate runtime-sized storage with malloc. Variable-length arrays are not supported. ${SEE_PAGE}.`,
);

export const VOID_POINTER_TYPE: FeatureInfo = outOfScope(
  'void-pointer-type',
  `'void *' is reserved for the malloc/free interface in this C subset — cast malloc's result directly to the non-void pointer type you need. ${SEE_PAGE}.`,
);

export const VOID_POINTER_ARITHMETIC: FeatureInfo = outOfScope(
  'void-pointer-arithmetic',
  `pointer arithmetic cannot use malloc's internal 'void *' result because it has no object size — cast the direct malloc result to the intended object-pointer type before doing arithmetic. ${SEE_PAGE}.`,
);

export const CAST_BEYOND_MALLOC_RESULT: FeatureInfo = outOfScope(
  'cast-beyond-malloc-result',
  `casts in this C subset exist only to name the non-void pointer type for malloc's result — write '(T *) malloc(...)'. ${SEE_PAGE}.`,
);

// This compiler's scanf data conversions are %d, %c, and %s
// (SCANF_OK_CONVERSIONS, check.ts); %% is the separate argument-free literal
// percent form. Only '%x' and '%b' of the unsupported specifiers named below
// are actually printf conversions here (PRINTF_OK_CONVERSIONS, check.ts) —
// printf accepting them while scanf does not is a real asymmetry a student
// could trip on, so this message names it explicitly rather than falling into
// the generic "specifier not recognized" catch-all. '%i', '%o', and '%u' are
// not printf conversions either; they are named here only because they are the
// hex/octal/unsigned family a student might reach for by analogy. This is a
// deliberate subset boundary rather than an implied future capability.
export const SCANF_UNSUPPORTED_CONVERSION: FeatureInfo = outOfScope(
  'scanf-conversion',
  `scanf here accepts '%d', '%c', and '%s'; '%%' matches a literal percent and takes no destination argument — '%x' and '%b' are printf conversions with no scanf counterpart, and '%i', '%o', and '%u' are not part of this subset either. ${SEE_PAGE}.`,
);

// printf's and scanf's own '%f' format-string conversion (the
// KEYWORD_FEATURES.float entry above covers declaring a variable `float`,
// a wholly separate, parser-owned case). This compiler has no floating
// point at all, so both checkPrintfFormat and checkScanfFormat route their
// '%f' rejection through this ONE entry instead of each hand-writing the
// same sentence — see check.ts's own top-of-file note on why there must be
// only one such site.
export const FLOAT_CONVERSION: FeatureInfo = outOfScope(
  'float-conversion',
  `'%f' is not supported — floating point is not part of this subset. ${SEE_PAGE}.`,
);

// Known library functions that this subset does not implement. A call to one
// gets a specific boundary diagnostic instead of the generic undeclared-
// function error, distinguishing unsupported library surface from a typo.
// puts and gets remain intentionally out of scope; their messages make no
// promise that they will be added later.
//
// scanf, strcmp, and strcpy are implemented builtins and therefore do not
// appear in this table. When a capability is implemented, its entry must be
// removed so diagnostics describe the compiler's current behavior.
//
// The puts and gets messages enumerate the complete builtin surface:
// putchar, getchar, printf, scanf, strcmp, strcpy, malloc, and free.
// Keeping that list here provides an actionable alternative without coupling
// diagnostics to an external document or release history.
//
// Messages state only the supported subset boundary; they do not infer what
// any particular course, text, or teaching material covers.
export const LIBRARY_FUNCTION_FEATURES: Readonly<Record<string, FeatureInfo>> = {
  calloc: outOfScope(
    'calloc',
    `'calloc' is not part of this C subset — allocate with malloc and initialize the returned storage explicitly. ${SEE_PAGE}.`,
  ),
  realloc: outOfScope(
    'realloc',
    `'realloc' is not part of this C subset — allocate replacement storage with malloc, copy the values you need, and free the old block. ${SEE_PAGE}.`,
  ),
  puts: outOfScope(
    'puts',
    `'puts' is not part of the supported C subset — the library functions here are putchar, getchar, printf, scanf, strcmp, strcpy, malloc, and free. ${SEE_PAGE}.`,
  ),
  gets: outOfScope(
    'gets',
    `'gets' is not part of the supported C subset — the library functions here are putchar, getchar, printf, scanf, strcmp, strcpy, malloc, and free. ${SEE_PAGE}.`,
  ),
};

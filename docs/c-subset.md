# C subset reference

`lc3cc` compiles a deliberately bounded C subset to assembly source for the
16-bit LC-3 teaching ISA. It is designed for readable compiler output, not for
complete C language or standard-library coverage.

Compiler diagnostics are the final authority for a particular input. This page
summarizes the accepted surface, records the nonstandard target semantics that
can change a program's result, and mirrors every key in the compiler's current
out-of-scope feature registry.

## Supported surface

### Types and declarations

- `int`, `char`, `bool`, and `_Bool`, each stored in one 16-bit word
- Boolean literals `true` and `false`
- `void` as a function return type or the empty parameter-list spelling
  `f(void)`; it is not a variable or source-level pointer type
- pointers and fixed-size one- and two-dimensional arrays; two-dimensional
  arrays are row-major
- read-only `const` local and global variables, each initialized at its
  declaration
- tagged `struct` definitions and file-scope `typedef` declarations
- forward aliases written as `typedef struct Tag Name;`
- one fixed array dimension on a struct member
- `sizeof` with a parenthesized type name, such as `sizeof(int)`
- scalar initialization and character-array initialization from a string
  literal
- global variables, local variables, parameters, function declarations, and
  function definitions
- a runnable entry point spelled `int main(void)` or `int main()`

`int` is a signed two's-complement 16-bit value. `char` is also a full 16-bit
word and does not narrow arithmetic to eight bits. `_Bool` and `bool` store only
`0` or `1`, and every pointer occupies one word. `sizeof` reports two bytes per
word, so `sizeof(char) == sizeof(int) == 2`. Code that depends on host C sizes,
byte-addressed pointers, or wider arithmetic is outside this compiler's
contract. A `sizeof` result above 32,767 bytes is rejected because current v1's
signed 16-bit result cannot represent it.

Arithmetic results are the resulting 16-bit word. The one mathematical
division quotient outside the signed range, `-32768 / -1`, completes after the
runtime's bounded repeated-subtraction path and produces `-32768` (`x8000`).
A runtime divisor of zero does not terminate; a divisor that is provably zero
is rejected at compile time.

A `const` identifier is a read-only memory object, not a compile-time constant.
Use a literal or object-like `#define` in array sizes, `case` labels, and global
constant expressions. Current v1 has no const-qualified pointer type, so direct
`&name` on a const identifier is rejected. Const is not propagated through
aggregate subobjects; this is a narrower v1 boundary, not a qualified-pointer
promise.

### Statements and expressions

- `if`/`else`, `while`, `do`/`while`, and `for`
- `switch` on `int`, `char`, or `bool`, with `case`, `default`, and fall-through
- `break`, `continue`, and `return`
- function calls and the conditional `?:` expression
- arithmetic, remainder, bitwise, shift, comparison, equality, and logical
  operators
- simple assignment; compound assignment on integral operands, plus `p += n`
  and `p -= n` for a pointer `p` and integral `n`
- prefix and postfix `++` and `--`
- address-of, dereference, array subscripting, `.` member access, and `->`
  member access
- pointer equality and inequality
- pointer-plus-integer and pointer-minus-integer arithmetic on object pointers,
  scaled by the pointed-to type

Pointer ordering and pointer-minus-pointer expressions are not accepted.
Pointer/pointer and integral/pointer compound assignments are not accepted.
Array subscripting and pointer dereference have no bounds check.

### Preprocessor

- object-like `#define` macros
- syntactically valid `#include <name>` and `#include "name"` directives,
  accepted without loading a header file
- predefined `NULL` with the value `0`
- `//` line comments

Function-like macros and other preprocessor directives are not supported.
`/* ... */` block comments are rejected; use `//` comments.

### Strings and builtins

Character and string literals are ASCII-only. String literals are accepted only
as the format argument to `printf` or `scanf`, or as the initializer of a
`char` array. They are not general-purpose pointer values. Named escapes and
`\0` are supported; hexadecimal escapes and numeric octal escapes other than
`\0` are not.

The builtin functions are:

- `putchar(int)` and `getchar()`
- `printf`, with `%d`, `%c`, `%x`, `%b`, `%s`, and `%%`
- `scanf`, with `%d`, `%c`, `%s`, and `%%`
- `strcmp` and `strcpy`
- `malloc` and `free`

`malloc` returns the compiler's internal `void *` interface. Source code casts
that result directly to the required non-void pointer type, for example
`(int *) malloc(sizeof(int))`. General casts and source-declared `void *` types
are not supported. Cast the direct `malloc` call before any pointer arithmetic:
`(struct Node *) malloc(sizeof(struct Node) * 2) + 1` advances by one complete
`struct Node`. Arithmetic on `malloc(...)` itself is rejected because the
internal `void *` result has no object size from which to derive a stride.

`malloc` takes a byte count under the two-bytes-per-word model and rounds an odd
positive count up to a whole word. It returns `NULL` for a nonpositive request
or when no block fits. `free(NULL)` does nothing; `free` does not validate any
other pointer.

## Runtime and capacity limits

A complete program begins at `x3000`. When allocation is used, its heap begins
after emitted code and data and grows upward only to `xE000`. The `xE000`
through `xEFFF` words are reserved for a runtime stack whose base is `xF000`.
Heap exhaustion returns `NULL`, but there is no stack-overflow check,
array/string bounds check, or general pointer-validation layer.

The compiler permits at most 512 words of global storage and 512 words in one
function frame. Exceeding either limit is a compile error and yields no
assembly. C source accepts LF, CRLF, and bare-CR line endings.

A constant zero divisor is a compile error. Division or remainder by a runtime
value of zero does not trap or terminate. A constant shift count must be from 0
through 15. Runtime counts at or below zero leave the value unchanged; counts
of 16 or more produce zero for left shift and sign fill for right shift.

## Out-of-scope registry

Each row below has status `out-of-scope` in the compiler feature registry. The
registry key is included verbatim so documentation drift can be detected
mechanically.

<!-- feature-registry:start -->

| Registry key                   | Current boundary                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `array-brace-initializer`      | Brace initializers are unavailable; initialize supported values explicitly.                    |
| `auto`                         | The `auto` storage-class keyword is unavailable.                                               |
| `bare-struct-forward`          | Use `typedef struct Tag Name;` instead of a bare tag declaration.                              |
| `block-scope-type-declaration` | Struct definitions and typedefs belong at file scope.                                          |
| `calloc`                       | Allocate with `malloc` and initialize the storage explicitly.                                  |
| `cast-beyond-malloc-result`    | Casts are limited to typing the direct result of `malloc`.                                     |
| `double`                       | Double-precision floating-point types are unavailable.                                         |
| `enum`                         | Enumerations are unavailable.                                                                  |
| `extern`                       | The `extern` storage-class keyword is unavailable.                                             |
| `float`                        | Floating-point types are unavailable.                                                          |
| `float-conversion`             | `%f` is unavailable in formatted input and output.                                             |
| `gets`                         | `gets` is not a builtin.                                                                       |
| `goto`                         | `goto` is unavailable.                                                                         |
| `long`                         | Long integer types are unavailable.                                                            |
| `pointer-relational`           | Pointers support `==` and `!=`, but not ordering comparisons.                                  |
| `pointer-subtraction`          | Subtracting one pointer from another is unavailable.                                           |
| `puts`                         | `puts` is not a builtin.                                                                       |
| `realloc`                      | Allocate replacement storage, copy explicitly, and then call `free`.                           |
| `register`                     | The `register` storage-class keyword is unavailable.                                           |
| `scanf-conversion`             | `scanf` excludes `%x`, `%b`, `%i`, `%o`, and `%u`.                                             |
| `short`                        | Short integer types are unavailable.                                                           |
| `signed`                       | The `signed` type modifier is unavailable.                                                     |
| `sizeof-expression`            | `sizeof` accepts a parenthesized type name, not an expression.                                 |
| `static`                       | The `static` storage-class keyword is unavailable.                                             |
| `string-literal-context`       | String literals are limited to format arguments and `char` array initialization.               |
| `struct-assignment`            | Assign struct members individually or operate through a pointer.                               |
| `struct-by-value-argument`     | Pass a pointer instead of passing a struct by value.                                           |
| `struct-member-array`          | A struct member array requires exactly one fixed dimension.                                    |
| `struct-return`                | Return a pointer instead of returning a struct by value.                                       |
| `struct-typed-member`          | Store a pointer instead of nesting a struct by value.                                          |
| `tagless-struct-typedef`       | A struct typedef requires an explicit tag.                                                     |
| `typedef-name-shadowing`       | Variables, parameters, and functions cannot reuse a typedef name.                              |
| `union`                        | Unions are unavailable.                                                                        |
| `unsigned`                     | Unsigned integer types are unavailable.                                                        |
| `unspecified-array-dimension`  | An omitted size is accepted only for the first dimension of an array parameter.                |
| `variable-length-array`        | Array sizes must be compile-time constants.                                                    |
| `variadic`                     | User-defined variadic functions are unavailable.                                               |
| `void-pointer-arithmetic`      | Cast the direct `malloc` result to an object-pointer type before doing pointer arithmetic.     |
| `void-pointer-type`            | Source code cannot declare `void *`; that type is reserved internally for allocation builtins. |
| `volatile`                     | The `volatile` qualifier is unavailable.                                                       |

<!-- feature-registry:end -->

## Compile-only boundary

The compiler emits assembly source. It does not preprocess external headers,
assemble, link, simulate, debug, or run a program. A successful compile without
`main` produces a non-runnable `fragment` rather than a complete `program`.

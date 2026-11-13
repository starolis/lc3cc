# Changelog

All notable user-visible changes to `lc3cc` are recorded here.

## 1.1.0 - 2026-11-13

### Added

- Compile programs whose generated code lands out of PC-relative reach.
  Version 1.0.0 rejected them with a "too far from its target" or "call range"
  diagnostic. A branch or pooled load reaches from 256 words back to 255
  ahead, and a call from 1024 back to 1023 ahead. Past that, the compiler now
  emits a longer form that loads the address into `R3`, with a comment on the
  line before it naming the target and the distance. A program that 1.0.0
  compiled produces the same assembly. See
  [Code out of reach](docs/c-subset.md#code-out-of-reach).

### Fixed

- A function named `f_POOL` no longer shares a label with the literal pool of
  a function named `f`; 1.0.0 emitted that label twice.

## 1.0.0 - 2026-08-27

### Fixed

- Fail closed before emitting oversized global storage, reject unsupported
  pointer compound assignments, arithmetic on `malloc`'s internal `void *`
  result, pointer-valued `switch` expressions, and direct mutable `&name`
  aliases to const identifiers.
- Diagnose `sizeof` results outside the positive signed 16-bit byte range and
  align the pointer-subtraction diagnostic with the closed current-v1 boundary.
- Compile string-initialized `char` arrays in `for` declarations and normalize
  CRLF or bare-CR source before emitting assembler input.
- Compile reads and writes through pointer-valued subscript bases such as
  `(p + n)[i]`, pointer-returning calls, and conditional pointer expressions.
- Ship self-contained JavaScript source maps and generate the documented
  line-map example from the exact source and compiler output it describes.

### Added

- Compile-only `lc3cc` command for emitting LC-3 assembly source to standard
  output or a file.
- ESM library with TypeScript declarations and the public compiler pipeline.
- Deterministic `--emit-map` JSON sidecars that map C source lines to assembly
  source-line ranges.
- Atomic file publication and fail-closed input/output path-alias checks.
- Documentation for the supported C subset and line-map schema.
- Node.js support for the 22, 24, and 26 release lines.

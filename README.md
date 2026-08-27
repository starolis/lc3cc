# lc3cc

`lc3cc` is a readable, line-mapped C compiler and TypeScript library for the
16-bit LC-3 teaching ISA. It accepts a documented C subset and emits LC-3
assembly source.

This is a compile-only tool. It does not assemble, link, simulate, debug, or run
the emitted program. Assembly syntax support varies among LC-3 tools, so this
package does not make a general assembler-compatibility claim.

## Release status

The 1.0.x line is supported beginning with version 1.0.0. Published versions
and provenance are listed on [npm](https://www.npmjs.com/package/lc3cc), while
source tags and releases are on [GitHub](https://github.com/starolis/lc3cc/releases).
The source may become visible before a matching npm version, so confirm the
exact registry version before installing it. See [CHANGELOG.md](CHANGELOG.md)
for the dated release contents.

## Requirements

- Node.js `^22.0.0`, `^24.0.0`, or `^26.0.0`
- No runtime package dependencies

## Install

Install the command globally:

```sh
npm install --global lc3cc
```

Or add it as an ESM library dependency:

```sh
npm install lc3cc
```

## Command line

Compile to standard output:

```sh
lc3cc input.c
```

The command accepts exactly one input path. It has no standard-input or
multiple-input/link mode: a bare `-` is not an input stream, and a filename that
begins with `-` must be made unambiguous with a path such as `./-input.c`.

Write assembly to a file:

```sh
lc3cc input.c -o output.asm
```

Write a versioned line-map sidecar while assembly still goes to standard
output:

```sh
lc3cc input.c --emit-map output.lc3map.json
```

Both file options may be used together:

```sh
lc3cc input.c -o output.asm --emit-map output.lc3map.json
```

Diagnostics are written to standard error as
`file:line:col: warning|error: message` in compiler order. Exit status `0`
means compilation succeeded, including warning-bearing fragments; `1` means
the compiler reported an error; and `2` means usage, input, serialization, or
output failed.

Input, assembly-output, and map-output paths must be pairwise distinct. File
outputs are installed through same-directory temporary files and rename, so a
compiler error does not truncate a requested destination.

Path checks resolve lexical normalization, symlink targets, and hard links.
Existing assembly and map destinations must be regular files and may not be
symlinks. Not-yet-created names that differ only by case or Unicode NFC
normalization are conservatively treated as colliding, even on a filesystem
that could distinguish them. `--emit-map -` is rejected; omit `-o` when
assembly should go to standard output. If `-o -` is supplied explicitly, `-`
is an ordinary output filename.

On Windows, drive-relative operands such as `C:input.c` are rejected because
their meaning depends on process-wide drive state. Use an ordinary relative
path such as `input.c` or a drive-absolute path such as `C:\work\input.c`.

The temporary-file guarantee covers handled failures on ordinary local
filesystems. It is not a cross-file transaction, a crash-durability guarantee,
or protection against an adversarial concurrent filesystem race.

See [Line maps](docs/line-map.md) for the sidecar format and its two-output
failure boundary.

## Library

The package exposes the compiler as ESM with TypeScript declarations:

```ts
import { compileC } from 'lc3cc';

const result = compileC('int main(void) { return 0; }\n');

for (const diagnostic of result.diagnostics) {
  console.error(
    `${diagnostic.line}:${diagnostic.col}: ${diagnostic.severity}: ${diagnostic.message}`,
  );
}

if (result.ok) {
  console.log(result.artifact); // "program" or "fragment"
  console.log(result.asm);
  console.log(result.lineMap);
}
```

The root export also provides the `lex`, `parse`, `check`, and `codegen` stages
and their public types. `compileC` is the convenient complete pipeline.

A successful result without a defined `main` is a `fragment`. Its assembly and
line map are useful for inspection, but the fragment is not a runnable program.

## C subset

The supported language includes 16-bit integer, character, and Boolean values;
functions and familiar control flow; pointers; fixed-size arrays; restricted
string literals; tagged structs and typedefs; `sizeof(type)`; and a small
builtin library including `malloc` and `free`.

The supported surface, important semantic limits, and every named
out-of-scope registry entry are documented in the
[C subset reference](docs/c-subset.md). This is intentionally not complete C.

## Output boundary

`lc3cc` emits readable assembly source for the LC-3 teaching ISA. It does not
invoke an assembler or prove that a particular third-party assembler accepts
the output. Verify the emitted syntax with the assembler used by your own
environment before depending on that combination.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance. Report
security-sensitive issues through the process in [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

# lc3cc

[![npm version](https://img.shields.io/npm/v/lc3cc.svg)](https://www.npmjs.com/package/lc3cc) [![CI](https://github.com/starolis/lc3cc/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/starolis/lc3cc/actions/workflows/ci.yml?query=branch%3Amain) [![Node.js support](https://img.shields.io/node/v/lc3cc.svg)](#requirements) [![License](https://img.shields.io/npm/l/lc3cc.svg)](https://github.com/starolis/lc3cc/blob/main/LICENSE)

`lc3cc` turns a documented C subset into readable assembly for the 16-bit LC-3
teaching ISA. Use it from the command line or as an ESM library with TypeScript
declarations.

- Readable assembly with C-source comments for inspection and teaching
- Deterministic C-line-to-assembly maps for tools and source-level navigation
- Zero runtime package dependencies

`lc3cc` is compile-only. It does not assemble, link, simulate, debug, or run
programs, and it makes no universal assembler-compatibility claim.

## Quick start

Save this as `example.c`:

```c
int main(void) {
  int value = 1;
  return value;
}
```

Compile it without installing anything globally:

```sh
npx --yes lc3cc@1.0.0 example.c -o example.asm --emit-map example.lc3map.json
```

The generated assembly includes the source relationship directly:

```asm
; C line 2: int value = 1;
AND R0,R0,#0
ADD R0,R0,#1
STR R0,R5,#0
; C line 3: return value;
LDR R0,R5,#0
STR R0,R5,#3
BR L_main_epilogue
```

`example.asm` is the readable LC-3 source. `example.lc3map.json` is the
machine-readable sidecar; see [Line maps](docs/line-map.md) for its versioned
format and schema.

To explore the surrounding compile-to-machine workflow interactively, open the
separate [interactive LC-3 simulator and C explorer](https://www.pastthemagic.com/lc3),
switch the language to **C**, and choose an example. The educational web app is
not a hosted build or runtime for the `lc3cc` npm package.

## Requirements

- Node.js `^22.0.0`, `^24.0.0`, or `^26.0.0`
- No runtime package dependencies

## Install

Install the command globally:

```sh
npm install --global lc3cc
```

Or add the ESM library to a project:

```sh
npm install lc3cc
```

## Command line

```text
usage: lc3cc <input.c> [-o <output.asm>] [--emit-map <output.lc3map.json>]
```

Common forms:

```sh
# Write assembly to standard output
lc3cc input.c

# Write assembly to a file
lc3cc input.c -o output.asm

# Write assembly and its structured line map
lc3cc input.c -o output.asm --emit-map output.lc3map.json

# Inspect the complete installed interface
lc3cc --help
lc3cc --version
```

Diagnostics are written to standard error as
`file:line:col: warning|error: message` in compiler order. Exit status `0`
means compilation succeeded, including warning-bearing fragments; `1` means
the compiler reported an error; and `2` means usage, input, serialization, or
output failed.

Input, assembly-output, and map-output paths must be pairwise distinct. File
outputs use same-directory temporary files and rename, so a handled failure
does not replace a destination with partial bytes. Assembly and map publication
are not a cross-file transaction; the details are below.

<details>
<summary>Filesystem and output details</summary>

The command accepts exactly one input path. It has no standard-input or
multiple-input/link mode: a bare `-` is not an input stream, and a filename that
begins with `-` must be made unambiguous with a path such as `./-input.c`.

Path checks resolve lexical normalization, symlink targets, and hard links.
Existing assembly and map destinations must be regular files and may not be
symlinks. Not-yet-created names that differ only by case or Unicode NFC
normalization are conservatively treated as colliding, even on a filesystem
that could distinguish them.

`--emit-map -` is rejected. Omit `-o` when assembly should go to standard
output. If `-o -` is supplied explicitly, `-` is an ordinary output filename.

On Windows, drive-relative operands such as `C:input.c` are rejected because
their meaning depends on process-wide drive state. Use an ordinary relative
path such as `input.c` or a drive-absolute path such as `C:\work\input.c`.

The temporary-file guarantee covers handled failures on ordinary local
filesystems. It is not a cross-file transaction, a crash-durability guarantee,
or protection against an adversarial concurrent filesystem race. The
[line-map documentation](docs/line-map.md) defines the two-output failure
boundary.

</details>

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

`compileC` is the complete pipeline. The root export also provides the `lex`,
`parse`, `check`, and `codegen` stages and their public types.

A successful result without a defined `main` is a `fragment`. Its assembly and
line map are useful for inspection, but the fragment is not a runnable program.

## Supported C subset

The supported language includes 16-bit integer, character, and Boolean values;
functions and familiar control flow; pointers; fixed-size arrays; restricted
string literals; tagged structs and typedefs; `sizeof(type)`; and a small
builtin library including `malloc` and `free`.

This is intentionally not complete C. The [C subset reference](docs/c-subset.md)
documents the accepted surface, important semantic limits, and every named
out-of-scope registry entry.

## Assembly compatibility

`lc3cc` emits readable assembly source for the LC-3 teaching ISA. It does not
invoke an assembler or prove that a particular third-party assembler accepts
the output. Verify the emitted syntax with the assembler used by your own
environment before depending on that combination.

## Releases and provenance

The supported 1.0.x line begins with
[`lc3cc@1.0.0`](https://www.npmjs.com/package/lc3cc). npm displays the package's
signed provenance, while source tags and release notes are available on
[GitHub](https://github.com/starolis/lc3cc/releases). See
[CHANGELOG.md](CHANGELOG.md) for dated user-visible changes.

For reproducible installs, pin the exact npm version. The repository's `main`
branch may contain documentation or release preparation that is newer than the
latest registry package.

## Help, contributing, and security

- [Open a question or bug report](https://github.com/starolis/lc3cc/issues/new)
- [Browse existing issues](https://github.com/starolis/lc3cc/issues)
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change
- Report a suspected vulnerability through
  [GitHub's private advisory form](https://github.com/starolis/lc3cc/security/advisories/new)
  after reading [SECURITY.md](SECURITY.md)

Please do not include confidential source code in a public issue. Reduce the
case or provide a synthetic reproducer instead.

## License

MIT. See [LICENSE](LICENSE).

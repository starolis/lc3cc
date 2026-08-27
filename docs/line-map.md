# Line-map sidecars

`lc3cc` can write a deterministic JSON sidecar that relates C source lines to
inclusive ranges of emitted assembly source lines:

```sh
lc3cc input.c -o output.asm --emit-map output.lc3map.json
```

The sidecar is a compile artifact. It contains no machine addresses, object
code, execution trace, simulator state, syntax tree, symbol table, or source
text. Mapping assembly lines to addresses requires a separate assembler and its
own mapping data.

The normative JSON structure is
[lc3cc-line-map.schema.json](lc3cc-line-map.schema.json).

## Example

This example is generated from the exact UTF-8 source bytes below, including
the final line feed, supplied as `input.c` with assembly written to
`output.asm`:

```c
int main(void) { return 0; }
```

```json
{
  "format": "lc3cc-line-map",
  "schemaVersion": 1,
  "compilerVersion": "1.0.0",
  "artifact": "program",
  "source": {
    "path": "input.c",
    "sha256": "2ad75d95660563887d8d3f1d0ae1dcf18c2379cbd83a5c72f5ab276351ee6949"
  },
  "assembly": {
    "path": "output.asm",
    "sha256": "98e43811428a1a7d2d3f8c174eebc21fbad605db7359f2c8c6bd9ef45c0ec87f",
    "lineCount": 34
  },
  "mappings": [
    {
      "cLine": null,
      "asmStart": 2,
      "asmEnd": 10,
      "kind": "startup"
    },
    {
      "cLine": null,
      "asmStart": 11,
      "asmEnd": 12,
      "kind": "data"
    },
    {
      "cLine": 1,
      "asmStart": 14,
      "asmEnd": 20,
      "kind": "prologue"
    },
    {
      "cLine": 1,
      "asmStart": 21,
      "asmEnd": 22,
      "kind": "stmt"
    },
    {
      "cLine": 1,
      "asmStart": 23,
      "asmEnd": 24,
      "kind": "epilogue"
    },
    {
      "cLine": 1,
      "asmStart": 26,
      "asmEnd": 31,
      "kind": "epilogue"
    },
    {
      "cLine": null,
      "asmStart": 33,
      "asmEnd": 33,
      "kind": "data"
    }
  ]
}
```

## Top-level fields

- `format` is always `lc3cc-line-map`.
- `schemaVersion` is `1` for this structure. An incompatible structure requires
  a new schema version.
- `compilerVersion` records the installed package version. It does not replace
  `schemaVersion`.
- `artifact` is `program` when the source defines `main`, or `fragment` for a
  successful compile without `main`.
- `source` identifies and hashes the exact input bytes.
- `assembly` identifies and hashes the exact UTF-8 assembly bytes.
- `mappings` preserves compiler order and field values.

Failed compiles do not produce a sidecar, and `none` is not a sidecar artifact
value.

## Paths and hashes

`source.path` is the input operand exactly as supplied. `assembly.path` is the
`-o` operand exactly as supplied, or `null` when assembly is written to standard
output. Neither field is changed to an absolute path.

The input operand is always a file path; `-` is not standard input.
`--emit-map -` is rejected because the sidecar always has a file destination.
Omitting `-o` sends assembly to standard output; an explicit `-o -` instead
names an ordinary file called `-`.

Both hashes are lowercase SHA-256 hexadecimal strings:

- `source.sha256` covers the exact bytes read from the input file before UTF-8
  compilation.
- `assembly.sha256` covers the exact emitted assembly string encoded as UTF-8.

The hashes make a stale or mismatched sidecar detectable without embedding the
source or assembly.

## Assembly line coordinates

`assembly.lineCount` uses the same physical-line coordinate space as the map:

- `0` when the assembly string is empty;
- otherwise, the length of `assembly.split("\n")`.

A trailing newline therefore contributes a final empty physical line.

Every mapping has:

- `cLine`: a one-based C source line, or `null` for generated content;
- `asmStart`: the one-based first assembly source line;
- `asmEnd`: the one-based inclusive last assembly source line; and
- `kind`: one of `stmt`, `prologue`, `epilogue`, `call`, `data`, `startup`, or
  `runtime`.

For every mapping, `asmStart <= asmEnd <= assembly.lineCount`. Mapping ranges
describe assembly source lines, not addresses or emitted word counts.

## Determinism

The sidecar is UTF-8 JSON with stable field order, two-space indentation, and
one final line feed. It has no timestamp, resolved path, working-directory
field, or other machine-specific metadata. Repeating the same successful
projection with the same version, operand paths, input bytes, assembly bytes,
and mappings produces the same sidecar bytes.

## Output failures

The map is published before assembly. Each file output uses a same-directory
temporary file followed by rename. If a later assembly-file write fails,
`lc3cc` exits with status `2` and makes a best-effort attempt to remove or
restore the map. One complete, hash-checkable map may remain. Bytes already
accepted by standard output cannot be rolled back.

The same best-effort map removal or restoration is attempted if writing
assembly to standard output fails after the map was published.

No transaction across two files, or across a file and standard output, is
promised.

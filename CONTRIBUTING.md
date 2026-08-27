# Contributing to lc3cc

Thank you for helping improve `lc3cc`. Contributions should preserve its narrow
purpose: a readable, compile-only C-to-LC-3 tool with a documented teaching
subset and stable public outputs.

## Before starting

- Search the [issue tracker](https://github.com/starolis/lc3cc/issues) before
  opening a duplicate, and review open pull requests for overlapping work.
- For a language-surface or output-format change, propose the compatibility
  decision in an issue before implementation.
- Read [SECURITY.md](SECURITY.md) before sharing a suspected vulnerability. Do
  not put sensitive details in a public issue or pull request.

## Development environment

Use a supported Node.js release: `^22.0.0`, `^24.0.0`, or `^26.0.0`.

Install dependencies from the checked-in lockfile:

```sh
npm ci
```

The root `package.json` is the authority for available commands. Before sending
a change, run the complete local checks:

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

Do not hand-edit generated build output.

## Source flow

The standalone repository is a curated export from a separate canonical
development tree. Source flow runs one way into the standalone repository.
Maintainers may reapply an accepted public change to the canonical source and
return it through a later export, so commit IDs are not preserved across that
boundary.

## Change guidelines

- Add focused tests that fail without the behavior being changed.
- Keep diagnostics actionable and deterministic.
- Treat emitted assembly, compiler diagnostics, public TypeScript exports, and
  the line-map schema as compatibility surfaces.
- Update [docs/c-subset.md](docs/c-subset.md) whenever accepted or rejected C
  syntax changes.
- Update [docs/line-map.md](docs/line-map.md) and its JSON schema together when
  line-map semantics change.
- Keep source, tests, comments, examples, and generated artifacts free of
  secrets, machine-local paths, and unrelated material.
- Do not add an assembler, linker, simulator, debugger, or execution command
  under the compiler CLI without an explicit scope decision.

## Bug reports

For an ordinary, non-sensitive bug, use the
[issue tracker](https://github.com/starolis/lc3cc/issues/new).

A useful report includes:

- the smallest C input that reproduces the behavior;
- the exact command or library call;
- expected and actual diagnostics or assembly;
- the `lc3cc` and Node.js versions; and
- the operating system and relevant filesystem details for I/O issues.

Please avoid attaching confidential source code. Reduce the example or create a
synthetic reproducer instead.

## Pull requests

Keep each pull request focused. Describe the user-visible effect, the tests that
own it, and any compatibility consequence. A change is ready when its tests,
types, formatting, build, documentation, and package-boundary checks pass.

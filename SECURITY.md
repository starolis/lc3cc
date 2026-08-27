# Security policy

## Supported versions

The 1.0.x line is the currently supported release line.

| Version | Security fixes |
| ------- | -------------- |
| `1.0.x` | Yes            |

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/starolis/lc3cc/security/advisories/new)
for security-sensitive reports. Never disclose exploit details, credentials,
confidential source, or other sensitive material in a public issue or pull
request.

Include:

- the affected `lc3cc` and Node.js versions;
- the operating system and filesystem when relevant;
- a minimal reproducer or proof of concept;
- the impact and required preconditions; and
- any known workaround.

Do not include credentials, private source code, or unrelated personal data.
The maintainers will acknowledge a report as soon as practical, investigate
it, and coordinate disclosure after a fix or mitigation is available. No
response-time or release-time guarantee is made.

## Scope

Examples of security-relevant reports include unintended file overwrite,
path-identity bypass, arbitrary code execution, package-integrity problems,
secret disclosure, and compiler inputs that cause unbounded resource use.

Incorrect assembly or a compiler diagnostic is usually a correctness bug, not
a vulnerability, unless it crosses a security boundary or produces a concrete
security impact. Use a public issue for an ordinary correctness report only
when the repository exposes an issue tracker.

`lc3cc` only compiles source to assembly text. It does not execute source code
or emitted assembly, and it does not provide an assembler, linker, simulator,
or sandbox.

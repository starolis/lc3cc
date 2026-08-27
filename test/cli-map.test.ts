import { createHash } from 'node:crypto';

import { compileC } from '../src/index.js';
import { describe, expect, test, vi } from 'vitest';

import {
  assertDistinctPaths,
  runCli,
  type CliCompileResult,
  type CliDependencies,
} from '../src/cli.js';
import { buildLineMapSidecar } from '../src/lineMap.js';

type StoredContents = string | Uint8Array;

const USAGE = 'usage: lc3cc <input.c> [-o <output.asm>] [--emit-map <output.lc3map.json>]\n';
const HELP = `${USAGE}
Compile the documented C subset to LC-3 assembly.

Options:
  -o <path>          Write assembly to a file instead of stdout
  --emit-map <path>  Write the structured line-map sidecar
  --help             Show this help
  --version          Show the installed version
`;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function cloneContents(contents: StoredContents): StoredContents {
  return typeof contents === 'string' ? contents : Uint8Array.from(contents);
}

function contentsAsString(contents: StoredContents | undefined): string | undefined {
  if (contents === undefined) return undefined;
  return typeof contents === 'string' ? contents : Buffer.from(contents).toString('utf8');
}

function successfulResult(assembly = 'HALT'): CliCompileResult {
  return {
    ok: true,
    asm: assembly,
    artifact: 'program',
    diagnostics: [],
    lineMap: [{ cLine: null, asmStart: 1, asmEnd: 1, kind: 'startup' }],
  };
}

function mapHarness(
  options: {
    initialFiles?: readonly (readonly [string, StoredContents])[];
    sourceBytes?: Uint8Array;
  } = {},
) {
  const sourceBytes = options.sourceBytes ?? bytes('int main(void) { return 0; }\n');
  const files = new Map<string, StoredContents>(
    (options.initialFiles ?? []).map(([path, contents]) => [path, cloneContents(contents)]),
  );
  const events: string[] = [];
  const inspectedPaths: unknown[][] = [];
  let stdout = '';
  let stderr = '';

  const dependencies = {
    assertDistinctPaths: async (operands: readonly unknown[]) => {
      events.push('preflight');
      inspectedPaths.push([...operands]);
    },
    compileC: (source: string) => {
      events.push('compile');
      return compileC(source);
    },
    readFileIfExists: async (path: string) => {
      events.push(`snapshot:${path}`);
      const contents = files.get(path);
      return contents === undefined
        ? null
        : typeof contents === 'string'
          ? bytes(contents)
          : Uint8Array.from(contents);
    },
    readSourceBytes: async () => {
      events.push('read-source');
      return Uint8Array.from(sourceBytes);
    },
    removeFileIfExists: async (path: string) => {
      events.push(`remove:${path}`);
      files.delete(path);
    },
    stderr: {
      write: async (text: string) => {
        stderr += text;
      },
    },
    stdout: {
      write: async (text: string) => {
        events.push('stdout');
        stdout += text;
      },
    },
    version: '1.0.0',
    writeFileAtomically: async (path: string, contents: StoredContents) => {
      events.push(`publish:${path}`);
      files.set(path, cloneContents(contents));
    },
  } as unknown as CliDependencies;

  return {
    dependencies,
    events,
    files,
    inspectedPaths,
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

describe('lc3cc line-map CLI integration', () => {
  test('--help owns the complete v1 option surface', async () => {
    const context = mapHarness();

    expect(await runCli(['--help'], context.dependencies)).toBe(0);
    expect(context.stdout()).toBe(HELP);
    expect(context.stderr()).toBe('');
    expect(context.events).toEqual(['stdout']);
  });

  test.each([
    ['missing value', ['input.c', '--emit-map'], 'lc3cc: option requires a path: --emit-map\n'],
    [
      'duplicate option',
      ['--emit-map', 'one.json', 'input.c', '--emit-map', 'two.json'],
      'lc3cc: option may only be used once: --emit-map\n',
    ],
    ['stdout sentinel', ['input.c', '--emit-map', '-'], 'lc3cc: --emit-map path may not be -\n'],
    [
      'known help token as a value',
      ['input.c', '--emit-map', '--help'],
      'lc3cc: option requires a path: --emit-map\n',
    ],
    [
      'adjacent duplicate option',
      ['input.c', '--emit-map', '--emit-map', 'map.json'],
      'lc3cc: option may only be used once: --emit-map\n',
    ],
  ])('%s is a named usage error before preflight', async (_name, argv, message) => {
    const context = mapHarness();

    expect(await runCli(argv, context.dependencies)).toBe(2);
    expect(context.stdout()).toBe('');
    expect(context.stderr()).toBe(message + USAGE);
    expect(context.events).toEqual([]);
  });

  test('all present paths are preflighted together in role order', async () => {
    const context = mapHarness();

    expect(
      await runCli(
        ['--emit-map', 'map.json', '-o', 'program.asm', 'src/../input.c'],
        context.dependencies,
      ),
    ).toBe(0);
    expect(context.inspectedPaths).toEqual([
      [
        { path: 'src/../input.c', role: 'input' },
        { path: 'program.asm', role: 'assembly output' },
        { path: 'map.json', role: 'map output' },
      ],
    ]);
    expect(context.events[0]).toBe('preflight');
  });

  test('the real checker rejects an assembly/map collision before reading source', async () => {
    const context = mapHarness();
    context.dependencies.assertDistinctPaths = assertDistinctPaths;

    expect(
      await runCli(
        ['input.c', '-o', 'artifact.out', '--emit-map', 'artifact.out'],
        context.dependencies,
      ),
    ).toBe(2);
    expect(context.stderr()).toBe('lc3cc: assembly output and map output use the same path\n');
    expect(context.events).toEqual([]);
  });

  test.each([
    ['input, assembly, map', ['input.c', '-o', 'program.asm', '--emit-map', 'map.json']],
    ['map, assembly, input', ['--emit-map', 'map.json', '-o', 'program.asm', 'input.c']],
    ['assembly, input, map', ['-o', 'program.asm', 'input.c', '--emit-map', 'map.json']],
    ['assembly, map, input', ['-o', 'program.asm', '--emit-map', 'map.json', 'input.c']],
  ])('flag order %s produces identical artifacts', async (_name, argv) => {
    const context = mapHarness();
    const direct = compileC('int main(void) { return 0; }\n');

    expect(await runCli(argv, context.dependencies)).toBe(0);
    expect(context.stdout()).toBe('');
    expect(context.stderr()).toBe('');
    expect(context.files.get('program.asm')).toBe(direct.asm);
    expect(contentsAsString(context.files.get('map.json'))).toBe(
      buildLineMapSidecar({
        assemblyPath: 'program.asm',
        compilerVersion: '1.0.0',
        compileResult: direct,
        sourceBytes: bytes('int main(void) { return 0; }\n'),
        sourcePath: 'input.c',
      }).json,
    );
  });

  test('a hyphen-leading map operand is accepted except for the exact stdout sentinel', async () => {
    const context = mapHarness();

    expect(
      await runCli(
        ['--emit-map', '-map.json', 'input.c', '-o', '-program.asm'],
        context.dependencies,
      ),
    ).toBe(0);
    expect(context.files.has('-map.json')).toBe(true);
    expect(context.files.has('-program.asm')).toBe(true);
  });

  test('a real program writes the exact projector bytes before byte-identical assembly', async () => {
    const source = 'int main(void) { return 0; }\n';
    const direct = compileC(source);
    const context = mapHarness({ sourceBytes: bytes(source) });
    const rawInput = './fixtures/../input.c';
    const rawAssembly = '../out/./program.asm';

    expect(
      await runCli(
        [rawInput, '--emit-map', 'program.lc3map.json', '-o', rawAssembly],
        context.dependencies,
      ),
    ).toBe(0);
    expect(context.files.get(rawAssembly)).toBe(direct.asm);
    expect(contentsAsString(context.files.get('program.lc3map.json'))).toBe(
      buildLineMapSidecar({
        assemblyPath: rawAssembly,
        compilerVersion: '1.0.0',
        compileResult: direct,
        sourceBytes: bytes(source),
        sourcePath: rawInput,
      }).json,
    );
    expect(context.events.filter((event) => event.startsWith('publish:'))).toEqual([
      'publish:program.lc3map.json',
      `publish:${rawAssembly}`,
    ]);
  });

  test('a warning-bearing fragment preserves diagnostics, assembly, and fragment map', async () => {
    const source = 'int helper(void) { return 7; }\n';
    const direct = compileC(source);
    const context = mapHarness({ sourceBytes: bytes(source) });

    expect(await runCli(['fragment.c', '--emit-map', 'fragment.json'], context.dependencies)).toBe(
      0,
    );
    expect(context.stdout()).toBe(direct.asm);
    expect(context.stderr()).toBe(
      direct.diagnostics
        .map(
          (diagnostic) =>
            `fragment.c:${diagnostic.line}:${diagnostic.col}: ${diagnostic.severity}: ${diagnostic.message}\n`,
        )
        .join(''),
    );
    expect(JSON.parse(contentsAsString(context.files.get('fragment.json')) ?? '{}')).toMatchObject({
      artifact: 'fragment',
      assembly: { path: null },
      mappings: direct.lineMap,
    });
  });

  test('an empty successful fragment emits empty assembly and exact zero-line map semantics', async () => {
    const direct = compileC('');
    const context = mapHarness({ sourceBytes: bytes('') });

    expect(await runCli(['empty.c', '--emit-map', 'empty.json'], context.dependencies)).toBe(0);
    expect(context.stdout()).toBe('');
    expect(context.stderr()).toBe(
      direct.diagnostics
        .map(
          (diagnostic) =>
            `empty.c:${diagnostic.line}:${diagnostic.col}: ${diagnostic.severity}: ${diagnostic.message}\n`,
        )
        .join(''),
    );
    expect(JSON.parse(contentsAsString(context.files.get('empty.json')) ?? '{}')).toMatchObject({
      artifact: 'fragment',
      assembly: {
        lineCount: 0,
        path: null,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      mappings: [],
    });
  });

  test.each([
    ['complete program', 'int main(void) { return 0; }\n'],
    ['warning fragment', 'int helper(void) { return 7; }\n'],
    ['empty fragment', ''],
  ])(
    '%s keeps no-flag and map assembly, diagnostics, and exit byte-identical',
    async (_name, source) => {
      const withoutMap = mapHarness({ sourceBytes: bytes(source) });
      const withMap = mapHarness({ sourceBytes: bytes(source) });

      const withoutMapExit = await runCli(['input.c'], withoutMap.dependencies);
      const withMapExit = await runCli(
        ['input.c', '--emit-map', 'output.lc3map.json'],
        withMap.dependencies,
      );

      expect(withMapExit).toBe(withoutMapExit);
      expect(withMap.stdout()).toBe(withoutMap.stdout());
      expect(withMap.stderr()).toBe(withoutMap.stderr());
      expect(withMap.files.has('output.lc3map.json')).toBe(true);
    },
  );

  test('hashes exact invalid input bytes before replacement-character decoding', async () => {
    const sourceBytes = Uint8Array.of(0xff, 0x41);
    const compile = vi.fn(() => successfulResult());
    const context = mapHarness({ sourceBytes });
    context.dependencies.compileC = compile;

    expect(await runCli(['raw.c', '--emit-map', 'raw.json'], context.dependencies)).toBe(0);
    expect(compile).toHaveBeenCalledWith('\ufffdA');
    const sidecar = JSON.parse(contentsAsString(context.files.get('raw.json')) ?? '{}');
    expect(sidecar.source.sha256).toBe(createHash('sha256').update(sourceBytes).digest('hex'));
    expect(sidecar.source.sha256).not.toBe(
      createHash('sha256').update(Buffer.from('\ufffdA', 'utf8')).digest('hex'),
    );
  });

  test('preserves UTF-8 BOM decoding and no-flag/map assembly equivalence', async () => {
    const source = 'int main(void) { return 0; }\n';
    const sourceBytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes(source)]);
    const noMapCompile = vi.fn(() => successfulResult('BOM ASSEMBLY'));
    const mapCompile = vi.fn(() => successfulResult('BOM ASSEMBLY'));
    const withoutMap = mapHarness({ sourceBytes });
    const withMap = mapHarness({ sourceBytes });
    withoutMap.dependencies.compileC = noMapCompile;
    withMap.dependencies.compileC = mapCompile;

    expect(await runCli(['bom.c'], withoutMap.dependencies)).toBe(0);
    expect(await runCli(['bom.c', '--emit-map', 'bom.json'], withMap.dependencies)).toBe(0);
    expect(noMapCompile).toHaveBeenCalledWith(`\ufeff${source}`);
    expect(mapCompile).toHaveBeenCalledWith(`\ufeff${source}`);
    expect(withoutMap.stdout()).toBe('BOM ASSEMBLY');
    expect(withMap.stdout()).toBe(withoutMap.stdout());
    expect(JSON.parse(contentsAsString(withMap.files.get('bom.json')) ?? '{}').source.sha256).toBe(
      createHash('sha256').update(sourceBytes).digest('hex'),
    );
  });

  test('a real BOM input matches compileC on the BOM-preserving decoded string', async () => {
    const source = 'int main(void) { return 0; }\n';
    const decoded = `\ufeff${source}`;
    const sourceBytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes(source)]);
    const direct = compileC(decoded);
    const withoutMap = mapHarness({ sourceBytes });
    const withMap = mapHarness({ sourceBytes });

    const withoutMapExit = await runCli(['bom.c'], withoutMap.dependencies);
    const withMapExit = await runCli(
      ['bom.c', '--emit-map', 'bom.lc3map.json'],
      withMap.dependencies,
    );
    const expectedDiagnostics = direct.diagnostics
      .map(
        (diagnostic) =>
          `bom.c:${diagnostic.line}:${diagnostic.col}: ${diagnostic.severity}: ${diagnostic.message}\n`,
      )
      .join('');

    expect(withoutMapExit).toBe(direct.ok ? 0 : 1);
    expect(withMapExit).toBe(withoutMapExit);
    expect(withoutMap.stderr()).toBe(expectedDiagnostics);
    expect(withMap.stderr()).toBe(expectedDiagnostics);
    expect(withoutMap.stdout()).toBe(direct.ok ? direct.asm : '');
    expect(withMap.stdout()).toBe(withoutMap.stdout());
    expect(withMap.files.has('bom.lc3map.json')).toBe(direct.ok);
  });

  test('a no-map invocation never snapshots, cleans up, or projects map-only fields', async () => {
    const context = mapHarness();
    context.dependencies.compileC = () => ({
      ...successfulResult(),
      lineMap: [{ cLine: 1, asmStart: 2, asmEnd: 1, kind: 'stmt' }],
    });

    expect(await runCli(['input.c'], context.dependencies)).toBe(0);
    expect(context.stdout()).toBe('HALT');
    expect(context.events.some((event) => event.startsWith('snapshot:'))).toBe(false);
    expect(context.events.some((event) => event.startsWith('publish:'))).toBe(false);
    expect(context.events.some((event) => event.startsWith('remove:'))).toBe(false);
  });

  test('compiler errors leave existing map and assembly destinations byte-identical', async () => {
    const priorMap = Uint8Array.of(0xff, 0x00, 0x0a);
    const context = mapHarness({
      initialFiles: [
        ['program.asm', 'old assembly'],
        ['program.json', priorMap],
      ],
      sourceBytes: bytes('int main(void) { return missing; }\n'),
    });

    expect(
      await runCli(
        ['error.c', '-o', 'program.asm', '--emit-map', 'program.json'],
        context.dependencies,
      ),
    ).toBe(1);
    expect(context.files.get('program.asm')).toBe('old assembly');
    expect(context.files.get('program.json')).toEqual(priorMap);
    expect(context.events.some((event) => event.startsWith('publish:'))).toBe(false);
    expect(context.events.some((event) => event.startsWith('snapshot:'))).toBe(false);
  });

  test('input read failure leaves existing map and assembly destinations byte-identical', async () => {
    const priorMap = Uint8Array.of(0xff, 0x00, 0x0a);
    const context = mapHarness({
      initialFiles: [
        ['program.asm', 'old assembly'],
        ['program.json', priorMap],
      ],
    });
    context.dependencies.readSourceBytes = async () => {
      throw new Error('permission denied');
    };

    expect(
      await runCli(
        ['input.c', '-o', 'program.asm', '--emit-map', 'program.json'],
        context.dependencies,
      ),
    ).toBe(2);
    expect(context.stderr()).toBe('lc3cc: cannot read input.c: permission denied\n');
    expect(context.files.get('program.asm')).toBe('old assembly');
    expect(context.files.get('program.json')).toEqual(priorMap);
    expect(context.events.some((event) => event.startsWith('publish:'))).toBe(false);
    expect(context.events.some((event) => event.startsWith('snapshot:'))).toBe(false);
  });

  test('serialization failure exits two before snapshot or publication', async () => {
    const context = mapHarness({ initialFiles: [['map.json', 'old map']] });
    context.dependencies.compileC = () => ({
      ...successfulResult(),
      lineMap: [{ cLine: 1, asmStart: 1, asmEnd: 2, kind: 'stmt' }],
    });

    expect(await runCli(['input.c', '--emit-map', 'map.json'], context.dependencies)).toBe(2);
    expect(context.stderr()).toBe(
      'lc3cc: cannot serialize map map.json: lc3cc line map: mapping range exceeds the emitted assembly\n',
    );
    expect(context.files.get('map.json')).toBe('old map');
    expect(context.events.some((event) => event.startsWith('snapshot:'))).toBe(false);
    expect(context.events.some((event) => event.startsWith('publish:'))).toBe(false);
  });

  test('snapshot read failure exits two before either artifact is published', async () => {
    const context = mapHarness();
    context.dependencies.readFileIfExists = async () => {
      throw new Error('permission denied');
    };

    expect(
      await runCli(
        ['input.c', '--emit-map', 'map.json', '-o', 'program.asm'],
        context.dependencies,
      ),
    ).toBe(2);
    expect(context.stderr()).toBe('lc3cc: cannot read existing map map.json: permission denied\n');
    expect(context.files.size).toBe(0);
    expect(context.events.some((event) => event.startsWith('publish:'))).toBe(false);
  });

  test('map publication failure leaves assembly unpublished and does not roll back', async () => {
    const context = mapHarness({ initialFiles: [['map.json', 'old map']] });
    context.dependencies.writeFileAtomically = async (path) => {
      context.events.push(`publish:${path}`);
      throw new Error('map disk full');
    };

    expect(
      await runCli(
        ['input.c', '--emit-map', 'map.json', '-o', 'program.asm'],
        context.dependencies,
      ),
    ).toBe(2);
    expect(context.stderr()).toBe('lc3cc: cannot write map.json: map disk full\n');
    expect(context.files.get('map.json')).toBe('old map');
    expect(context.files.has('program.asm')).toBe(false);
    expect(context.events.filter((event) => event.startsWith('publish:'))).toEqual([
      'publish:map.json',
    ]);
    expect(context.events.some((event) => event.startsWith('remove:'))).toBe(false);
  });

  test.each([
    ['non-UTF-8 bytes', Uint8Array.of(0xff, 0x00, 0x0a)],
    ['an empty file', Uint8Array.of()],
  ])('assembly failure restores a preexisting map byte-for-byte: %s', async (_name, priorMap) => {
    const context = mapHarness({ initialFiles: [['map.json', priorMap]] });
    let publishedMap = false;
    context.dependencies.writeFileAtomically = async (path, contents) => {
      context.events.push(`publish:${path}`);
      if (path === 'program.asm') throw new Error('assembly disk full');
      if (path === 'map.json') publishedMap = true;
      context.files.set(path, cloneContents(contents));
    };

    expect(
      await runCli(
        ['input.c', '--emit-map', 'map.json', '-o', 'program.asm'],
        context.dependencies,
      ),
    ).toBe(2);
    expect(publishedMap).toBe(true);
    expect(context.stderr()).toBe('lc3cc: cannot write program.asm: assembly disk full\n');
    expect(context.files.get('map.json')).toEqual(priorMap);
    expect(context.files.has('program.asm')).toBe(false);
    expect(context.events.filter((event) => event.startsWith('publish:'))).toEqual([
      'publish:map.json',
      'publish:program.asm',
      'publish:map.json',
    ]);
    expect(context.events.filter((event) => event === 'snapshot:map.json')).toHaveLength(1);
  });

  test('assembly failure removes a newly created map', async () => {
    const context = mapHarness();
    context.dependencies.writeFileAtomically = async (path, contents) => {
      context.events.push(`publish:${path}`);
      if (path === 'program.asm') throw new Error('assembly disk full');
      context.files.set(path, cloneContents(contents));
    };

    expect(
      await runCli(
        ['input.c', '--emit-map', 'map.json', '-o', 'program.asm'],
        context.dependencies,
      ),
    ).toBe(2);
    expect(context.files.has('map.json')).toBe(false);
    expect(context.events).toContain('remove:map.json');
  });

  test('stdout failure preserves accepted bytes but restores the preexisting map', async () => {
    const priorMap = Uint8Array.of(0xff, 0x00, 0x0a);
    const context = mapHarness({ initialFiles: [['map.json', priorMap]] });
    const direct = compileC('int main(void) { return 0; }\n');
    let accepted = '';
    context.dependencies.stdout = {
      write: async (text) => {
        accepted = text.slice(0, 4);
        throw new Error('broken pipe');
      },
    };

    expect(await runCli(['input.c', '--emit-map', 'map.json'], context.dependencies)).toBe(2);
    expect(accepted).toBe(direct.asm.slice(0, 4));
    expect(context.files.get('map.json')).toEqual(priorMap);
    expect(context.stderr()).toBe('lc3cc: cannot write stdout: broken pipe\n');
  });

  test('map removal failure is appended to the primary assembly failure', async () => {
    const context = mapHarness();
    context.dependencies.writeFileAtomically = async (path, contents) => {
      context.events.push(`publish:${path}`);
      if (path === 'program.asm') throw new Error('assembly disk full');
      context.files.set(path, cloneContents(contents));
    };
    context.dependencies.removeFileIfExists = async () => {
      throw new Error('cleanup denied');
    };

    expect(
      await runCli(
        ['input.c', '--emit-map', 'map.json', '-o', 'program.asm'],
        context.dependencies,
      ),
    ).toBe(2);
    expect(context.stderr()).toBe(
      'lc3cc: cannot write program.asm: assembly disk full; cannot remove map map.json: cleanup denied\n',
    );
    expect(contentsAsString(context.files.get('map.json'))).toContain('"format": "lc3cc-line-map"');
  });

  test('map restoration failure is appended and leaves a complete new sidecar', async () => {
    const priorMap = Uint8Array.of(0xff, 0x00, 0x0a);
    const context = mapHarness({ initialFiles: [['map.json', priorMap]] });
    let mapWrites = 0;
    context.dependencies.writeFileAtomically = async (path, contents) => {
      context.events.push(`publish:${path}`);
      if (path === 'program.asm') throw new Error('assembly disk full');
      mapWrites += 1;
      if (mapWrites === 2) throw new Error('restore denied');
      context.files.set(path, cloneContents(contents));
    };

    expect(
      await runCli(
        ['input.c', '--emit-map', 'map.json', '-o', 'program.asm'],
        context.dependencies,
      ),
    ).toBe(2);
    expect(context.stderr()).toBe(
      'lc3cc: cannot write program.asm: assembly disk full; cannot restore map map.json: restore denied\n',
    );
    expect(contentsAsString(context.files.get('map.json'))).toContain('"format": "lc3cc-line-map"');
  });

  test('warning diagnostic write failure occurs before map or assembly publication', async () => {
    const context = mapHarness({
      sourceBytes: bytes('int helper(void) { return 7; }\n'),
    });
    let writes = 0;
    let reported = '';
    context.dependencies.stderr = {
      write: async (text) => {
        writes += 1;
        if (writes === 1) throw new Error('warning sink failed');
        reported += text;
      },
    };

    expect(
      await runCli(
        ['fragment.c', '--emit-map', 'map.json', '-o', 'fragment.asm'],
        context.dependencies,
      ),
    ).toBe(2);
    expect(reported).toBe('lc3cc: cannot write stderr: warning sink failed\n');
    expect(context.files.size).toBe(0);
    expect(context.events.some((event) => event.startsWith('publish:'))).toBe(false);
  });
});

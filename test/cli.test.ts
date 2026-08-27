import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { compileC } from '../src/index.js';

import {
  assertDistinctPaths,
  isWindowsDriveRelativePath,
  readFileIfExists,
  removeFileIfExists,
  runCli,
  streamWriter,
  writeFileAtomically,
  type AtomicFileContents,
  type AtomicFileOperations,
  type CliCompileResult,
  type CliDependencies,
  type PathIdentityOperations,
} from '../src/cli.js';

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

function successfulCompileResult(assembly = 'assembly'): CliCompileResult {
  return {
    ok: true,
    asm: assembly,
    artifact: 'program',
    diagnostics: [],
    lineMap: [],
  };
}

function renderedDiagnostics(
  input: string,
  diagnostics: ReturnType<typeof compileC>['diagnostics'],
): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `${input}:${diagnostic.line}:${diagnostic.col}: ${diagnostic.severity}: ${diagnostic.message}\n`,
    )
    .join('');
}

function harness(overrides: Partial<CliDependencies> = {}) {
  let stdout = '';
  let stderr = '';
  const files = new Map<string, AtomicFileContents>();
  const dependencies: CliDependencies = {
    assertDistinctPaths: async () => undefined,
    compileC: () => successfulCompileResult(),
    readFileIfExists: async (path) => {
      const contents = files.get(path);
      if (contents === undefined) return null;
      return typeof contents === 'string' ? bytes(contents) : Uint8Array.from(contents);
    },
    readSourceBytes: async () => bytes('int main(void) { return 0; }'),
    removeFileIfExists: async (path) => {
      files.delete(path);
    },
    stdout: {
      write: async (text) => {
        stdout += text;
      },
    },
    stderr: {
      write: async (text) => {
        stderr += text;
      },
    },
    version: '1.0.0',
    writeFileAtomically: async (path, contents) => {
      files.set(path, contents);
    },
    ...overrides,
  };
  return {
    dependencies,
    files,
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

async function withTemporaryDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'lc3cc-cli-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe('lc3cc CLI shell', () => {
  test('--help reports the complete v1 surface without reading or compiling', async () => {
    const compile = vi.fn(() => successfulCompileResult(''));
    const readSourceBytes = vi.fn(async () => bytes(''));
    const context = harness({ compileC: compile, readSourceBytes });

    expect(await runCli(['--help'], context.dependencies)).toBe(0);
    expect(context.stdout()).toBe(HELP);
    expect(context.stderr()).toBe('');
    expect(readSourceBytes).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
  });

  test('--version reports the installed package version without reading or compiling', async () => {
    const compile = vi.fn(() => successfulCompileResult(''));
    const readSourceBytes = vi.fn(async () => bytes(''));
    const context = harness({ compileC: compile, readSourceBytes });

    expect(await runCli(['--version'], context.dependencies)).toBe(0);
    expect(context.stdout()).toBe('lc3cc 1.0.0\n');
    expect(context.stderr()).toBe('');
    expect(readSourceBytes).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
  });

  test('a complete program emits byte-identical compileC assembly on stdout', async () => {
    const source = 'int main(void) { return 0; }\n';
    const direct = compileC(source);
    const context = harness({ compileC, readSourceBytes: async () => bytes(source) });

    expect(direct.ok).toBe(true);
    expect(direct.artifact).toBe('program');
    expect(await runCli(['program.c'], context.dependencies)).toBe(0);
    expect(context.stdout()).toBe(direct.asm);
    expect(context.stderr()).toBe(renderedDiagnostics('program.c', direct.diagnostics));
    expect(context.files).toEqual(new Map());
  });

  test('a warning-bearing fragment preserves compiler order and still exits zero', async () => {
    const source = 'int helper(void) { return 7; }\n';
    const direct = compileC(source);
    const context = harness({ compileC, readSourceBytes: async () => bytes(source) });

    expect(direct.ok).toBe(true);
    expect(direct.artifact).toBe('fragment');
    expect(direct.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(['warning']);
    expect(await runCli(['fragment.c'], context.dependencies)).toBe(0);
    expect(context.stdout()).toBe(direct.asm);
    expect(context.stderr()).toBe(renderedDiagnostics('fragment.c', direct.diagnostics));
  });

  test.each([
    ['input before -o', ['program.c', '-o', 'program.asm'], 'program.asm'],
    ['-o before input', ['-o', 'program.asm', 'program.c'], 'program.asm'],
    ['a hyphen-leading output path', ['program.c', '-o', '-output.asm'], '-output.asm'],
  ])('%s writes byte-identical assembly through the output seam', async (_name, argv, output) => {
    const source = 'int main(void) { return 0; }\n';
    const direct = compileC(source);
    const context = harness({ compileC, readSourceBytes: async () => bytes(source) });

    expect(await runCli(argv, context.dependencies)).toBe(0);
    expect(context.stdout()).toBe('');
    expect(context.stderr()).toBe(renderedDiagnostics('program.c', direct.diagnostics));
    expect(context.files).toEqual(new Map([[output, direct.asm]]));
  });

  test('compiler errors render in compiler order, exit one, and publish no assembly', async () => {
    const source = 'int main(void) { return first + second; }\n';
    const direct = compileC(source);
    const publish = vi.fn(async () => undefined);
    const context = harness({
      compileC,
      readSourceBytes: async () => bytes(source),
      writeFileAtomically: publish,
    });

    expect(direct.ok).toBe(false);
    expect(direct.diagnostics.length).toBeGreaterThanOrEqual(2);
    expect(await runCli(['error.c', '-o', 'existing.asm'], context.dependencies)).toBe(1);
    expect(context.stdout()).toBe('');
    expect(context.stderr()).toBe(renderedDiagnostics('error.c', direct.diagnostics));
    expect(publish).not.toHaveBeenCalled();
  });

  test.each([
    ['no input', [], 'lc3cc: exactly one input file is required\n'],
    ['multiple inputs', ['one.c', 'two.c'], 'lc3cc: exactly one input file is required\n'],
    ['unknown option', ['input.c', '--unknown'], 'lc3cc: unknown option: --unknown\n'],
    ['missing -o value', ['input.c', '-o'], 'lc3cc: option requires a path: -o\n'],
    [
      'known option as -o value',
      ['input.c', '-o', '--emit-map', 'map.json'],
      'lc3cc: option requires a path: -o\n',
    ],
    [
      'duplicate -o',
      ['input.c', '-o', 'one.asm', '-o', 'two.asm'],
      'lc3cc: option may only be used once: -o\n',
    ],
    ['help with an input', ['--help', 'input.c'], 'lc3cc: --help must be used alone\n'],
    ['version with an input', ['input.c', '--version'], 'lc3cc: --version must be used alone\n'],
  ])('%s is a named usage error', async (_name, argv, message) => {
    const compile = vi.fn(() => successfulCompileResult(''));
    const readSourceBytes = vi.fn(async () => bytes(''));
    const publish = vi.fn(async () => undefined);
    const context = harness({
      compileC: compile,
      readSourceBytes,
      writeFileAtomically: publish,
    });

    expect(await runCli(argv, context.dependencies)).toBe(2);
    expect(context.stdout()).toBe('');
    expect(context.stderr()).toBe(message + USAGE);
    expect(readSourceBytes).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  test('input read failures are named and exit two without compiling', async () => {
    const compile = vi.fn(() => successfulCompileResult(''));
    const context = harness({
      compileC: compile,
      readSourceBytes: async () => {
        throw new Error('permission denied');
      },
    });

    expect(await runCli(['missing.c'], context.dependencies)).toBe(2);
    expect(context.stdout()).toBe('');
    expect(context.stderr()).toBe('lc3cc: cannot read missing.c: permission denied\n');
    expect(compile).not.toHaveBeenCalled();
  });

  test('unexpected compiler throws are named and exit two without assembly', async () => {
    const context = harness({
      compileC: () => {
        throw new Error('unexpected failure');
      },
    });

    expect(await runCli(['input.c'], context.dependencies)).toBe(2);
    expect(context.stdout()).toBe('');
    expect(context.stderr()).toBe('lc3cc: cannot compile input.c: unexpected failure\n');
    expect(context.files).toEqual(new Map());
  });

  test('assembly file write failures are named and exit two', async () => {
    const context = harness({
      writeFileAtomically: async () => {
        throw new Error('disk full');
      },
    });

    expect(await runCli(['input.c', '-o', 'output.asm'], context.dependencies)).toBe(2);
    expect(context.stdout()).toBe('');
    expect(context.stderr()).toBe('lc3cc: cannot write output.asm: disk full\n');
  });

  test('stdout write failures are named and exit two', async () => {
    let stderr = '';
    const context = harness({
      stdout: {
        write: async () => {
          throw new Error('broken pipe');
        },
      },
      stderr: {
        write: async (text) => {
          stderr += text;
        },
      },
    });

    expect(await runCli(['input.c'], context.dependencies)).toBe(2);
    expect(stderr).toBe('lc3cc: cannot write stdout: broken pipe\n');
  });

  test('the stream adapter turns a delayed callback and error event into exit two', async () => {
    let errorListener: ((error: Error) => void) | null = null;
    const stream = {
      once: (_event: 'error', listener: (error: Error) => void) => {
        errorListener = listener;
      },
      off: (_event: 'error', listener: (error: Error) => void) => {
        if (errorListener === listener) errorListener = null;
      },
      write: (_text: string, callback: (error: Error | null | undefined) => void) => {
        queueMicrotask(() => {
          const error = new Error('delayed EPIPE');
          callback(error);
          errorListener?.(error);
        });
      },
    };
    const context = harness({ stdout: streamWriter(stream) });

    expect(await runCli(['input.c'], context.dependencies)).toBe(2);
    expect(context.stderr()).toBe('lc3cc: cannot write stdout: delayed EPIPE\n');
  });
});

describe('lc3cc path identity', () => {
  test.each([
    ['plain relative', 'source.c', false],
    ['parent relative', `..${sep}source.c`, false],
    ['drive absolute with backslashes', 'C:\\source.c', false],
    ['drive absolute with slashes', 'C:/source.c', false],
    ['root relative', '\\source.c', false],
    ['UNC', '\\\\server\\share\\source.c', false],
    ['drive relative', 'C:source.c', true],
    ['bare drive', 'C:', true],
  ] as const)('classifies %s paths for native Windows handling', (_kind, path, expected) => {
    expect(isWindowsDriveRelativePath(path, 'win32')).toBe(expected);
  });

  test('drive-relative classification defaults to the native platform', () => {
    expect(isWindowsDriveRelativePath('C:source.c')).toBe(process.platform === 'win32');
  });

  test('native Windows drive-relative operands fail before filesystem inspection', async () => {
    const operations: PathIdentityOperations = {
      lstat: vi.fn(),
      realpath: vi.fn(),
      stat: vi.fn(),
    };

    await expect(
      assertDistinctPaths(
        [
          { path: 'input.c', role: 'input' },
          { path: 'C:output.asm', role: 'assembly output' },
        ],
        operations,
        'win32',
      ),
    ).rejects.toThrow(
      'assembly output C:output.asm uses a Windows drive-relative path, which is not supported',
    );
    expect(operations.lstat).not.toHaveBeenCalled();
    expect(operations.realpath).not.toHaveBeenCalled();
    expect(operations.stat).not.toHaveBeenCalled();
  });

  test.each([
    ['lexical', 'use the same path'],
    ['normalized', 'normalize to the same path'],
    ['symlink', 'resolve to the same path'],
    ['hard link', 'refer to the same file'],
  ])('%s input/output aliases fail before compilation or publication', async (kind, reason) => {
    await withTemporaryDirectory(async (directory) => {
      const input = join(directory, 'input.c');
      await writeFile(input, 'int main(void) { return 0; }\n', 'utf8');

      let output: string;
      if (kind === 'lexical') {
        output = input;
      } else if (kind === 'normalized') {
        output = `${join(directory, 'missing-segment')}${sep}..${sep}input.c`;
      } else if (kind === 'symlink') {
        const target = join(directory, 'target.c');
        await writeFile(target, 'int main(void) { return 0; }\n', 'utf8');
        await rm(input);
        await symlink(target, input);
        output = target;
      } else {
        output = join(directory, 'output.asm');
        await link(input, output);
      }

      const compile = vi.fn(() => successfulCompileResult('new assembly'));
      const publish = vi.fn(writeFileAtomically);
      const context = harness({
        assertDistinctPaths,
        compileC: compile,
        readSourceBytes: (path) => readFile(path),
        writeFileAtomically: publish,
      });

      expect(await runCli([input, '-o', output], context.dependencies)).toBe(2);
      expect(context.stdout()).toBe('');
      expect(context.stderr()).toBe(`lc3cc: input and assembly output ${reason}\n`);
      expect(compile).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(await readFile(input, 'utf8')).toBe('int main(void) { return 0; }\n');
      expect((await readdir(directory)).some((name) => name.includes('.lc3cc-'))).toBe(false);
    });
  });

  test.each(['existing', 'dangling'])('%s output leaf symlinks fail closed', async (kind) => {
    await withTemporaryDirectory(async (directory) => {
      const input = join(directory, 'input.c');
      const output = join(directory, 'output.asm');
      const target = join(directory, 'target.asm');
      await writeFile(input, 'int main(void) { return 0; }\n', 'utf8');
      if (kind === 'existing') await writeFile(target, 'unrelated bytes', 'utf8');
      await symlink(target, output);
      const compile = vi.fn(() => successfulCompileResult('new assembly'));
      const publish = vi.fn(writeFileAtomically);
      const context = harness({
        assertDistinctPaths,
        compileC: compile,
        readSourceBytes: (path) => readFile(path),
        writeFileAtomically: publish,
      });

      expect(await runCli([input, '-o', output], context.dependencies)).toBe(2);
      expect(context.stderr()).toBe(`lc3cc: assembly output ${output} is a symbolic link\n`);
      expect(compile).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect((await readdir(directory)).some((name) => name.includes('.lc3cc-'))).toBe(false);
    });
  });

  test('missing outputs are canonicalized through their deepest existing ancestors', async () => {
    await withTemporaryDirectory(async (directory) => {
      const realDirectory = join(directory, 'real');
      const aliasDirectory = join(directory, 'alias');
      await mkdir(realDirectory);
      await symlink(realDirectory, aliasDirectory);

      await expect(
        assertDistinctPaths([
          { path: join(realDirectory, 'future.asm'), role: 'assembly output' },
          { path: join(aliasDirectory, 'future.asm'), role: 'map output' },
        ]),
      ).rejects.toThrow(
        'assembly output and map output resolve through existing ancestors to the same path',
      );
    });
  });

  test.each([
    ['case folding', 'future.asm', 'FUTURE.ASM'],
    ['Unicode normalization', '\u00e9.asm', 'e\u0301.asm'],
  ])('real missing outputs collide under conservative %s', async (_kind, leftName, rightName) => {
    await withTemporaryDirectory(async (directory) => {
      await expect(
        assertDistinctPaths([
          { path: join(directory, leftName), role: 'assembly output' },
          { path: join(directory, rightName), role: 'map output' },
        ]),
      ).rejects.toThrow('assembly output and map output have the same normalized future path');
    });
  });

  test.each([
    ['case folding', 'future.asm', 'FUTURE.ASM'],
    ['Unicode normalization', '\u00e9.asm', 'e\u0301.asm'],
  ])(
    'injected missing outputs collide under conservative %s',
    async (_kind, leftName, rightName) => {
      const stat = vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true }));
      const operations: PathIdentityOperations = {
        lstat: async (path) => {
          if (basename(path).endsWith('.asm') || basename(path).endsWith('.ASM')) {
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          }
          return { isSymbolicLink: () => false };
        },
        realpath: async () => resolve('/canonical-parent'),
        stat,
      };

      await expect(
        assertDistinctPaths(
          [
            { path: join('/left', leftName), role: 'assembly output' },
            { path: join('/right', rightName), role: 'map output' },
          ],
          operations,
        ),
      ).rejects.toThrow('assembly output and map output have the same normalized future path');
      expect(stat).not.toHaveBeenCalled();
    },
  );

  test('an ordinary missing input reaches the named read-failure path', async () => {
    await withTemporaryDirectory(async (directory) => {
      const input = join(directory, 'missing.c');
      const compile = vi.fn(() => successfulCompileResult('new assembly'));
      const context = harness({
        assertDistinctPaths,
        compileC: compile,
        readSourceBytes: (path) => readFile(path),
      });

      expect(await runCli([input], context.dependencies)).toBe(2);
      expect(context.stderr()).toContain(`lc3cc: cannot read ${input}:`);
      expect(compile).not.toHaveBeenCalled();
    });
  });

  test('path-classification failures other than ENOENT fail closed', async () => {
    const realpath = vi.fn(async (path: string) => path);
    const stat = vi.fn(async () => ({ dev: 1n, ino: 1n, isFile: () => true }));
    const operations: PathIdentityOperations = {
      lstat: async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
      realpath,
      stat,
    };

    await expect(
      assertDistinctPaths([{ path: 'input.c', role: 'input' }], operations),
    ).rejects.toThrow('cannot inspect input input.c: permission denied');
    expect(realpath).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  test.each(['input', 'assembly output'] as const)(
    'an existing non-regular %s fails before read, compile, or publication',
    async (role) => {
      await withTemporaryDirectory(async (directory) => {
        const ordinaryInput = join(directory, 'input.c');
        const nonRegular = join(directory, 'not-a-file');
        await writeFile(ordinaryInput, 'int main(void) { return 0; }\n', 'utf8');
        await mkdir(nonRegular);
        const input = role === 'input' ? nonRegular : ordinaryInput;
        const output = role === 'assembly output' ? nonRegular : join(directory, 'output.asm');
        const readSourceBytes = vi.fn((path: string) => readFile(path));
        const compile = vi.fn(() => successfulCompileResult('new assembly'));
        const publish = vi.fn(writeFileAtomically);
        const context = harness({
          assertDistinctPaths,
          compileC: compile,
          readSourceBytes,
          writeFileAtomically: publish,
        });

        expect(await runCli([input, '-o', output], context.dependencies)).toBe(2);
        expect(context.stderr()).toBe(`lc3cc: ${role} ${nonRegular} is not a regular file\n`);
        expect(readSourceBytes).not.toHaveBeenCalled();
        expect(compile).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
      });
    },
  );

  test('symlink-before-dotdot input identity cannot be authorized by a lexical decoy', async () => {
    await withTemporaryDirectory(async (directory) => {
      const lexicalDirectory = join(directory, 'lexical');
      const targetDirectory = join(directory, 'target');
      const targetChild = join(targetDirectory, 'child');
      await mkdir(lexicalDirectory);
      await mkdir(targetDirectory);
      await mkdir(targetChild);
      await symlink(targetChild, join(lexicalDirectory, 'link'));

      const source = 'int main(void) { return 0; }\n';
      const actual = join(targetDirectory, 'actual.c');
      const decoy = join(lexicalDirectory, 'actual.c');
      const rawInput = `${lexicalDirectory}${sep}link${sep}..${sep}actual.c`;
      await writeFile(actual, source, 'utf8');
      await writeFile(decoy, 'decoy source\n', 'utf8');
      const readSourceBytes = vi.fn((path: string) => readFile(path));
      const compile = vi.fn(() => successfulCompileResult('assembly bytes'));
      const publish = vi.fn(writeFileAtomically);
      const context = harness({
        assertDistinctPaths,
        compileC: compile,
        readSourceBytes,
        writeFileAtomically: publish,
      });

      const exitCode = await runCli([rawInput, '-o', actual], context.dependencies);

      expect(await readFile(actual, 'utf8')).toBe(source);
      expect(await readFile(decoy, 'utf8')).toBe('decoy source\n');
      expect((await readdir(targetDirectory)).some((name) => name.startsWith('.lc3cc-'))).toBe(
        false,
      );
      expect(exitCode).toBe(2);
      expect(context.stderr()).toBe('lc3cc: input and assembly output resolve to the same path\n');
      expect(readSourceBytes).not.toHaveBeenCalled();
      expect(compile).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    });
  });

  test('safe symlink-before-dotdot output publishes to the kernel-resolved target', async () => {
    await withTemporaryDirectory(async (directory) => {
      const lexicalDirectory = join(directory, 'lexical');
      const targetDirectory = join(directory, 'target');
      const targetChild = join(targetDirectory, 'child');
      await mkdir(lexicalDirectory);
      await mkdir(targetDirectory);
      await mkdir(targetChild);
      await symlink(targetChild, join(lexicalDirectory, 'link'));

      const input = join(targetDirectory, 'input.c');
      const actualOutput = join(targetDirectory, 'output.asm');
      const decoyOutput = join(lexicalDirectory, 'output.asm');
      const rawOutput = `${lexicalDirectory}${sep}link${sep}..${sep}output.asm`;
      await writeFile(input, 'int main(void) { return 0; }\n', 'utf8');
      await writeFile(decoyOutput, 'decoy bytes', 'utf8');
      const context = harness({
        assertDistinctPaths,
        compileC: () => successfulCompileResult('assembly bytes'),
        readSourceBytes: (path) => readFile(path),
        writeFileAtomically,
      });

      expect(await runCli([input, '-o', rawOutput], context.dependencies)).toBe(0);
      expect(await readFile(actualOutput, 'utf8')).toBe('assembly bytes');
      expect(await readFile(decoyOutput, 'utf8')).toBe('decoy bytes');
      expect((await readdir(targetDirectory)).some((name) => name.startsWith('.lc3cc-'))).toBe(
        false,
      );
      expect(context.stderr()).toBe('');
    });
  });
});

function memoryAtomicOperations(failure: 'none' | 'write' | 'close' | 'rename') {
  const destination = resolve('/virtual/output.asm');
  const temporary = join(dirname(destination), '.lc3cc-owned.tmp');
  const files = new Map<string, AtomicFileContents>([[destination, 'existing bytes']]);
  const events: string[] = [];
  const operations: AtomicFileOperations = {
    uniqueSuffix: () => 'owned',
    openExclusive: async (path) => {
      events.push(`open:${path}`);
      if (files.has(path)) {
        throw Object.assign(new Error('temporary already exists'), { code: 'EEXIST' });
      }
      files.set(path, '');
      return {
        write: async (contents) => {
          events.push('write');
          if (failure === 'write') {
            files.set(path, contents.slice(0, 3));
            throw new Error('disk full');
          }
          files.set(path, contents);
        },
        close: async () => {
          events.push('close');
          if (failure === 'close') throw new Error('close failed');
        },
      };
    },
    rename: async (from, to) => {
      events.push(`rename:${from}:${to}`);
      if (failure === 'rename') throw new Error('rename failed');
      const contents = files.get(from);
      if (contents === undefined) throw new Error('temporary is missing');
      files.set(to, contents);
      files.delete(from);
    },
    unlink: async (path) => {
      events.push(`unlink:${path}`);
      if (!files.delete(path)) {
        throw Object.assign(new Error('file not found'), { code: 'ENOENT' });
      }
    },
  };
  return { destination, events, files, operations, temporary };
}

describe('lc3cc atomic file publication', () => {
  test('publishes complete bytes by exclusive same-directory temporary then rename', async () => {
    const context = memoryAtomicOperations('none');

    await writeFileAtomically(context.destination, 'complete assembly', context.operations);

    expect(context.files.get(context.destination)).toBe('complete assembly');
    expect(context.files.has(context.temporary)).toBe(false);
    expect(dirname(context.temporary)).toBe(dirname(context.destination));
    expect(context.events).toEqual([
      `open:${context.temporary}`,
      'write',
      'close',
      `rename:${context.temporary}:${context.destination}`,
    ]);
  });

  test.each(['write', 'close', 'rename'] as const)(
    '%s failure preserves the destination and removes the owned temporary',
    async (failure) => {
      const context = memoryAtomicOperations(failure);

      await expect(
        writeFileAtomically(context.destination, 'complete assembly', context.operations),
      ).rejects.toThrow();

      expect(context.files.get(context.destination)).toBe('existing bytes');
      expect(context.files.has(context.temporary)).toBe(false);
      expect(context.events).toContain(`unlink:${context.temporary}`);
    },
  );

  test('an exclusive-open collision never removes a temporary it does not own', async () => {
    const context = memoryAtomicOperations('none');
    context.files.set(context.temporary, 'unrelated bytes');

    await expect(
      writeFileAtomically(context.destination, 'complete assembly', context.operations),
    ).rejects.toThrow('temporary already exists');

    expect(context.files.get(context.destination)).toBe('existing bytes');
    expect(context.files.get(context.temporary)).toBe('unrelated bytes');
    expect(context.events.some((event) => event.startsWith('unlink:'))).toBe(false);
  });

  test('an unavailable cleanup operation is surfaced rather than reported as clean', async () => {
    const context = memoryAtomicOperations('rename');
    context.operations.unlink = async (path) => {
      context.events.push(`unlink:${path}`);
      throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
    };

    await expect(
      writeFileAtomically(context.destination, 'complete assembly', context.operations),
    ).rejects.toThrow('rename failed; temporary cleanup failed: cleanup denied');

    expect(context.files.get(context.destination)).toBe('existing bytes');
    expect(context.files.has(context.temporary)).toBe(true);
  });

  test('the Node implementation atomically replaces an existing destination without residue', async () => {
    await withTemporaryDirectory(async (directory) => {
      const destination = join(directory, 'output.asm');
      await writeFile(destination, 'existing bytes', 'utf8');

      await writeFileAtomically(destination, 'complete assembly');

      expect(await readFile(destination, 'utf8')).toBe('complete assembly');
      expect(await readdir(directory)).toEqual(['output.asm']);
    });
  });

  test('runCli restores a preexisting non-UTF-8 map through the real byte writer', async () => {
    await withTemporaryDirectory(async (directory) => {
      const input = join(directory, 'input.c');
      const assembly = join(directory, 'output.asm');
      const map = join(directory, 'output.json');
      const priorMap = Uint8Array.of(0xff, 0x00, 0x0a);
      await writeFile(input, 'int main(void) { return 0; }\n', 'utf8');
      await writeFile(map, priorMap);
      const context = harness({
        assertDistinctPaths,
        compileC,
        readFileIfExists,
        readSourceBytes: (path) => readFile(path),
        removeFileIfExists,
        writeFileAtomically: async (path, contents) => {
          if (path === assembly) throw new Error('injected assembly failure');
          await writeFileAtomically(path, contents);
        },
      });

      expect(await runCli([input, '--emit-map', map, '-o', assembly], context.dependencies)).toBe(
        2,
      );
      expect(context.stderr()).toBe(`lc3cc: cannot write ${assembly}: injected assembly failure\n`);
      expect(await readFile(map)).toEqual(Buffer.from(priorMap));
      expect(await readdir(directory)).toEqual(['input.c', 'output.json']);
    });
  });

  test('a valid long destination basename still receives a short owned temporary', async () => {
    await withTemporaryDirectory(async (directory) => {
      const name = `${'a'.repeat(208)}.asm`;
      const destination = join(directory, name);
      expect(Buffer.byteLength(name)).toBe(212);

      await writeFileAtomically(destination, 'complete assembly');

      expect(await readFile(destination, 'utf8')).toBe('complete assembly');
      expect(await readdir(directory)).toEqual([name]);
    });
  });

  test('a real rename failure removes the same-directory owned temporary', async () => {
    await withTemporaryDirectory(async (directory) => {
      const destination = join(directory, 'output.asm');
      await mkdir(destination);

      await expect(writeFileAtomically(destination, 'complete assembly')).rejects.toThrow();

      expect(await readdir(directory)).toEqual(['output.asm']);
    });
  });

  test.each([
    ['read failure', 2],
    ['compiler throw', 2],
    ['compiler diagnostic', 1],
  ])('%s leaves an existing destination byte-identical', async (stage, exitCode) => {
    await withTemporaryDirectory(async (directory) => {
      const input = join(directory, 'input.c');
      const destination = join(directory, 'output.asm');
      await writeFile(input, 'int main(void) { return 0; }\n', 'utf8');
      await writeFile(destination, 'sentinel bytes', 'utf8');
      const context = harness({
        assertDistinctPaths,
        compileC:
          stage === 'compiler throw'
            ? () => {
                throw new Error('compiler failed');
              }
            : stage === 'compiler diagnostic'
              ? () => ({
                  ok: false,
                  asm: '',
                  artifact: 'none' as const,
                  diagnostics: [{ col: 1, line: 1, message: 'rejected source', severity: 'error' }],
                  lineMap: [],
                })
              : () => successfulCompileResult('new assembly'),
        readSourceBytes:
          stage === 'read failure'
            ? async () => {
                throw new Error('read failed');
              }
            : (path) => readFile(path),
        writeFileAtomically,
      });

      expect(await runCli([input, '-o', destination], context.dependencies)).toBe(exitCode);
      expect(await readFile(destination, 'utf8')).toBe('sentinel bytes');
      expect((await readdir(directory)).sort()).toEqual(['input.c', 'output.asm']);
    });
  });

  test('runCli preserves an existing destination when atomic publication fails', async () => {
    const atomic = memoryAtomicOperations('write');
    const context = harness({
      writeFileAtomically: (path, contents) =>
        writeFileAtomically(path, contents, atomic.operations),
    });

    expect(await runCli(['input.c', '-o', atomic.destination], context.dependencies)).toBe(2);
    expect(context.stderr()).toBe(`lc3cc: cannot write ${atomic.destination}: disk full\n`);
    expect(atomic.files.get(atomic.destination)).toBe('existing bytes');
    expect(atomic.files.has(atomic.temporary)).toBe(false);
  });
});

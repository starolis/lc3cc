import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { buildLineMapSidecar, type LineMapCompileResult } from './lineMap.js';

export interface CliDiagnostic {
  line: number;
  col: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface CliCompileResult extends LineMapCompileResult {
  diagnostics: readonly CliDiagnostic[];
}

interface CliWritable {
  write(text: string): Promise<void>;
}

interface CallbackWritable {
  once(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  write(text: string, callback: (error: Error | null | undefined) => void): unknown;
}

export type CliPathRole = 'input' | 'assembly output' | 'map output';

export interface CliPathOperand {
  path: string;
  role: CliPathRole;
}

interface PathStatus {
  isSymbolicLink(): boolean;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  isFile(): boolean;
}

export interface PathIdentityOperations {
  lstat(path: string): Promise<PathStatus>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileIdentity>;
}

export interface AtomicFileHandle {
  write(contents: AtomicFileContents): Promise<void>;
  close(): Promise<void>;
}

export type AtomicFileContents = string | Uint8Array;

export interface AtomicFileOperations {
  uniqueSuffix(): string;
  openExclusive(path: string): Promise<AtomicFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface CliDependencies {
  assertDistinctPaths(operands: readonly CliPathOperand[]): Promise<void>;
  compileC(source: string): CliCompileResult;
  readFileIfExists(path: string): Promise<Uint8Array | null>;
  readSourceBytes(path: string): Promise<Uint8Array>;
  removeFileIfExists(path: string): Promise<void>;
  writeFileAtomically(path: string, contents: AtomicFileContents): Promise<void>;
  stdout: CliWritable;
  stderr: CliWritable;
  version: string;
}

interface CompileArguments {
  action: 'compile';
  input: string;
  mapOutput: string | null;
  output: string | null;
}

type InformationalArguments = { action: 'help' } | { action: 'version' };

interface InvalidArguments {
  action: 'invalid';
  message: string;
}

type ParsedArguments = CompileArguments | InformationalArguments | InvalidArguments;

const USAGE = 'usage: lc3cc <input.c> [-o <output.asm>] [--emit-map <output.lc3map.json>]\n';

const HELP = `${USAGE}
Compile the documented C subset to LC-3 assembly.

Options:
  -o <path>          Write assembly to a file instead of stdout
  --emit-map <path>  Write the structured line-map sidecar
  --help             Show this help
  --version          Show the installed version
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

const NODE_PATH_OPERATIONS: PathIdentityOperations = {
  lstat,
  realpath,
  stat: async (path) => {
    const identity = await stat(path, { bigint: true });
    return {
      dev: identity.dev,
      ino: identity.ino,
      isFile: () => identity.isFile(),
    };
  },
};

const NODE_ATOMIC_OPERATIONS: AtomicFileOperations = {
  uniqueSuffix: randomUUID,
  openExclusive: async (path) => {
    const handle = await open(path, 'wx');
    return {
      write: async (contents) => {
        if (typeof contents === 'string') {
          await handle.writeFile(contents, { encoding: 'utf8' });
        } else {
          await handle.writeFile(contents);
        }
      },
      close: async () => handle.close(),
    };
  },
  rename,
  unlink,
};

interface InspectedPath {
  canonical: string;
  futureKey: string;
  identity: FileIdentity | null;
  operand: CliPathOperand;
  throughAncestor: boolean;
}

function inspectionFailure(operand: CliPathOperand, error: unknown): Error {
  return new Error(`cannot inspect ${operand.role} ${operand.path}: ${errorMessage(error)}`, {
    cause: error,
  });
}

function conservativeFuturePathKey(path: string): string {
  return path
    .split(sep)
    .map((component) => component.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC'))
    .join(sep);
}

export function isWindowsDriveRelativePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && /^[A-Za-z]:(?![\\/])/.test(path);
}

function appendRawSegment(parent: string, segment: string): string {
  return parent.endsWith(sep) ? `${parent}${segment}` : `${parent}${sep}${segment}`;
}

function rawAbsolutePath(path: string): string {
  if (isWindowsDriveRelativePath(path)) {
    throw new Error(`${path} uses a Windows drive-relative path, which is not supported`);
  }
  return isAbsolute(path) ? path : appendRawSegment(process.cwd(), path);
}

async function inspectPath(
  operand: CliPathOperand,
  operations: PathIdentityOperations,
): Promise<InspectedPath> {
  let existingAncestor = rawAbsolutePath(operand.path);
  let isLeaf = true;
  const missingSuffix: string[] = [];

  while (true) {
    let status: PathStatus;
    try {
      status = await operations.lstat(existingAncestor);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw inspectionFailure(operand, error);

      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw inspectionFailure(operand, error);
      missingSuffix.unshift(basename(existingAncestor));
      existingAncestor = parent;
      isLeaf = false;
      continue;
    }

    if (isLeaf && operand.role !== 'input' && status.isSymbolicLink()) {
      throw new Error(`${operand.role} ${operand.path} is a symbolic link`);
    }

    let canonicalAncestor: string;
    try {
      canonicalAncestor = await operations.realpath(existingAncestor);
    } catch (error) {
      throw inspectionFailure(operand, error);
    }

    let identity: FileIdentity | null = null;
    if (missingSuffix.length === 0) {
      try {
        identity = await operations.stat(existingAncestor);
      } catch (error) {
        throw inspectionFailure(operand, error);
      }
      if (!identity.isFile()) {
        throw new Error(`${operand.role} ${operand.path} is not a regular file`);
      }
    }

    const canonical = join(canonicalAncestor, ...missingSuffix);
    return {
      canonical,
      futureKey: conservativeFuturePathKey(canonical),
      identity,
      operand,
      throughAncestor: missingSuffix.length > 0,
    };
  }
}

function pairs<T>(values: readonly T[]): Array<readonly [T, T]> {
  const result: Array<readonly [T, T]> = [];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      const leftValue = values[left];
      const rightValue = values[right];
      if (leftValue !== undefined && rightValue !== undefined) {
        result.push([leftValue, rightValue]);
      }
    }
  }
  return result;
}

function collisionMessage(left: CliPathOperand, right: CliPathOperand, reason: string): Error {
  return new Error(`${left.role} and ${right.role} ${reason}`);
}

export async function assertDistinctPaths(
  operands: readonly CliPathOperand[],
  operations: PathIdentityOperations = NODE_PATH_OPERATIONS,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  for (const operand of operands) {
    if (isWindowsDriveRelativePath(operand.path, platform)) {
      throw new Error(
        `${operand.role} ${operand.path} uses a Windows drive-relative path, which is not supported`,
      );
    }
  }

  for (const [left, right] of pairs(operands)) {
    if (left.path === right.path) {
      throw collisionMessage(left, right, 'use the same path');
    }
    if (resolve(left.path) === resolve(right.path)) {
      throw collisionMessage(left, right, 'normalize to the same path');
    }
  }

  const inspected: InspectedPath[] = [];
  for (const operand of operands) inspected.push(await inspectPath(operand, operations));

  for (const [left, right] of pairs(inspected)) {
    if (left.canonical === right.canonical) {
      const reason =
        left.throughAncestor || right.throughAncestor
          ? 'resolve through existing ancestors to the same path'
          : 'resolve to the same path';
      throw collisionMessage(left.operand, right.operand, reason);
    }
    // Uncreated names have no filesystem identity. NFC plus locale-independent
    // case conversion is deliberately fail-closed: it can reject distinct future
    // names on a case-sensitive filesystem, but it cannot let two outputs alias
    // when created on a case- or normalization-insensitive filesystem.
    if ((left.throughAncestor || right.throughAncestor) && left.futureKey === right.futureKey) {
      throw collisionMessage(left.operand, right.operand, 'have the same normalized future path');
    }
    if (
      left.identity !== null &&
      right.identity !== null &&
      left.identity.dev === right.identity.dev &&
      left.identity.ino === right.identity.ino
    ) {
      throw collisionMessage(left.operand, right.operand, 'refer to the same file');
    }
  }
}

export async function writeFileAtomically(
  destination: string,
  contents: AtomicFileContents,
  operations: AtomicFileOperations = NODE_ATOMIC_OPERATIONS,
): Promise<void> {
  const absoluteDestination = rawAbsolutePath(destination);
  const temporary = appendRawSegment(
    dirname(absoluteDestination),
    `.lc3cc-${operations.uniqueSuffix()}.tmp`,
  );
  let handle: AtomicFileHandle | null = null;
  let ownsTemporary = false;

  try {
    handle = await operations.openExclusive(temporary);
    ownsTemporary = true;
    await handle.write(contents);
    await handle.close();
    handle = null;
    await operations.rename(temporary, absoluteDestination);
    ownsTemporary = false;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (handle !== null) {
      try {
        await handle.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (ownsTemporary) {
      try {
        await operations.unlink(temporary);
      } catch (cleanupError) {
        if (errorCode(cleanupError) !== 'ENOENT') cleanupErrors.push(cleanupError);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new Error(
        `${errorMessage(error)}; temporary cleanup failed: ${cleanupErrors
          .map(errorMessage)
          .join('; ')}`,
        { cause: new AggregateError([error, ...cleanupErrors]) },
      );
    }
    throw error;
  }
}

export async function readFileIfExists(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

export async function removeFileIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

export function streamWriter(stream: CallbackWritable): CliWritable {
  return {
    write: (text) =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const rejectOnce = (error: unknown): void => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        const onError = (error: Error): void => {
          rejectOnce(error);
        };

        stream.once('error', onError);
        try {
          stream.write(text, (error) => {
            if (error !== null && error !== undefined) {
              // Keep the one-shot listener until the stream emits the same error.
              // Without it, Node turns a callback-reported EPIPE into an uncaught event.
              rejectOnce(error);
              return;
            }

            stream.off('error', onError);
            if (settled) return;
            settled = true;
            resolve();
          });
        } catch (error) {
          // Preserve the listener in case the stream follows the throw with an
          // error event; the failed CLI invocation will not reuse this writer.
          rejectOnce(error);
        }
      }),
  };
}

async function write(stream: CliWritable, text: string): Promise<void> {
  await stream.write(text);
}

async function reportFailure(stderr: CliWritable, message: string): Promise<number> {
  try {
    await write(stderr, `lc3cc: ${message}\n`);
  } catch {
    // A broken stderr cannot carry its own failure, but it is still an I/O error.
  }
  return 2;
}

async function usage(stderr: CliWritable, message: string): Promise<number> {
  try {
    await write(stderr, `lc3cc: ${message}\n${USAGE}`);
  } catch {
    // A broken stderr cannot carry its own failure, but it is still an I/O error.
  }
  return 2;
}

function isKnownOption(argument: string): boolean {
  return (
    argument === '-o' ||
    argument === '--emit-map' ||
    argument === '--help' ||
    argument === '--version'
  );
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.length === 1 && argv[0] === '--help') return { action: 'help' };
  if (argv.length === 1 && argv[0] === '--version') return { action: 'version' };

  let input: string | null = null;
  let mapOutput: string | null = null;
  let output: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;

    if (argument === '--help' || argument === '--version') {
      return { action: 'invalid', message: `${argument} must be used alone` };
    }

    if (argument === '-o') {
      if (output !== null) {
        return { action: 'invalid', message: 'option may only be used once: -o' };
      }

      const path = argv[index + 1];
      if (path === argument) {
        return { action: 'invalid', message: 'option may only be used once: -o' };
      }
      if (path === undefined || isKnownOption(path)) {
        return { action: 'invalid', message: 'option requires a path: -o' };
      }
      output = path;
      index += 1;
      continue;
    }

    if (argument === '--emit-map') {
      if (mapOutput !== null) {
        return { action: 'invalid', message: 'option may only be used once: --emit-map' };
      }

      const path = argv[index + 1];
      if (path === argument) {
        return { action: 'invalid', message: 'option may only be used once: --emit-map' };
      }
      if (path === undefined || isKnownOption(path)) {
        return { action: 'invalid', message: 'option requires a path: --emit-map' };
      }
      if (path === '-') {
        return { action: 'invalid', message: '--emit-map path may not be -' };
      }
      mapOutput = path;
      index += 1;
      continue;
    }

    if (argument.startsWith('-')) {
      return { action: 'invalid', message: `unknown option: ${argument}` };
    }

    if (input !== null) {
      return { action: 'invalid', message: 'exactly one input file is required' };
    }
    input = argument;
  }

  if (input === null) {
    return { action: 'invalid', message: 'exactly one input file is required' };
  }

  return { action: 'compile', input, mapOutput, output };
}

async function renderDiagnostics(
  input: string,
  diagnostics: readonly CliDiagnostic[],
  stderr: CliWritable,
): Promise<void> {
  for (const diagnostic of diagnostics) {
    await write(
      stderr,
      `${input}:${diagnostic.line}:${diagnostic.col}: ${diagnostic.severity}: ${diagnostic.message}\n`,
    );
  }
}

async function rollbackPublishedMap(
  mapPath: string,
  previousBytes: Uint8Array | null,
  dependencies: CliDependencies,
): Promise<string | null> {
  try {
    if (previousBytes === null) {
      await dependencies.removeFileIfExists(mapPath);
    } else {
      await dependencies.writeFileAtomically(mapPath, previousBytes);
    }
    return null;
  } catch (error) {
    const action = previousBytes === null ? 'remove' : 'restore';
    return `cannot ${action} map ${mapPath}: ${errorMessage(error)}`;
  }
}

function withRollbackFailure(primary: string, rollbackFailure: string | null): string {
  return rollbackFailure === null ? primary : `${primary}; ${rollbackFailure}`;
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseArguments(argv);
  if (parsed.action === 'invalid') {
    return usage(dependencies.stderr, parsed.message);
  }

  if (parsed.action === 'help') {
    try {
      await write(dependencies.stdout, HELP);
      return 0;
    } catch (error) {
      return reportFailure(dependencies.stderr, `cannot write stdout: ${errorMessage(error)}`);
    }
  }

  if (parsed.action === 'version') {
    try {
      await write(dependencies.stdout, `lc3cc ${dependencies.version}\n`);
      return 0;
    } catch (error) {
      return reportFailure(dependencies.stderr, `cannot write stdout: ${errorMessage(error)}`);
    }
  }

  const paths: CliPathOperand[] = [{ path: parsed.input, role: 'input' }];
  if (parsed.output !== null) {
    paths.push({ path: parsed.output, role: 'assembly output' });
  }
  if (parsed.mapOutput !== null) {
    paths.push({ path: parsed.mapOutput, role: 'map output' });
  }
  try {
    await dependencies.assertDistinctPaths(paths);
  } catch (error) {
    return reportFailure(dependencies.stderr, errorMessage(error));
  }

  let sourceBytes: Uint8Array;
  try {
    sourceBytes = Uint8Array.from(await dependencies.readSourceBytes(parsed.input));
  } catch (error) {
    return reportFailure(
      dependencies.stderr,
      `cannot read ${parsed.input}: ${errorMessage(error)}`,
    );
  }

  const source = Buffer.from(sourceBytes).toString('utf8');

  let result: CliCompileResult;
  try {
    result = dependencies.compileC(source);
  } catch (error) {
    return reportFailure(
      dependencies.stderr,
      `cannot compile ${parsed.input}: ${errorMessage(error)}`,
    );
  }

  try {
    await renderDiagnostics(parsed.input, result.diagnostics, dependencies.stderr);
  } catch (error) {
    return reportFailure(dependencies.stderr, `cannot write stderr: ${errorMessage(error)}`);
  }

  const hasError = result.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  if (!result.ok || hasError) return 1;

  if (parsed.mapOutput === null) {
    if (parsed.output !== null) {
      try {
        await dependencies.writeFileAtomically(parsed.output, result.asm);
        return 0;
      } catch (error) {
        return reportFailure(
          dependencies.stderr,
          `cannot write ${parsed.output}: ${errorMessage(error)}`,
        );
      }
    }

    try {
      await write(dependencies.stdout, result.asm);
      return 0;
    } catch (error) {
      return reportFailure(dependencies.stderr, `cannot write stdout: ${errorMessage(error)}`);
    }
  }

  let mapJson: string;
  try {
    mapJson = buildLineMapSidecar({
      assemblyPath: parsed.output,
      compilerVersion: dependencies.version,
      compileResult: result,
      sourceBytes,
      sourcePath: parsed.input,
    }).json;
  } catch (error) {
    return reportFailure(
      dependencies.stderr,
      `cannot serialize map ${parsed.mapOutput}: ${errorMessage(error)}`,
    );
  }

  let previousMapBytes: Uint8Array | null;
  try {
    const snapshot = await dependencies.readFileIfExists(parsed.mapOutput);
    previousMapBytes = snapshot === null ? null : Uint8Array.from(snapshot);
  } catch (error) {
    return reportFailure(
      dependencies.stderr,
      `cannot read existing map ${parsed.mapOutput}: ${errorMessage(error)}`,
    );
  }

  try {
    await dependencies.writeFileAtomically(parsed.mapOutput, mapJson);
  } catch (error) {
    return reportFailure(
      dependencies.stderr,
      `cannot write ${parsed.mapOutput}: ${errorMessage(error)}`,
    );
  }

  let publicationFailure: string;
  if (parsed.output !== null) {
    try {
      await dependencies.writeFileAtomically(parsed.output, result.asm);
      return 0;
    } catch (error) {
      publicationFailure = `cannot write ${parsed.output}: ${errorMessage(error)}`;
    }
  } else {
    try {
      await write(dependencies.stdout, result.asm);
      return 0;
    } catch (error) {
      publicationFailure = `cannot write stdout: ${errorMessage(error)}`;
    }
  }

  const rollbackFailure = await rollbackPublishedMap(
    parsed.mapOutput,
    previousMapBytes,
    dependencies,
  );
  return reportFailure(
    dependencies.stderr,
    withRollbackFailure(publicationFailure, rollbackFailure),
  );
}

import { createHash } from 'node:crypto';

export const LINE_MAP_FORMAT = 'lc3cc-line-map' as const;
export const LINE_MAP_SCHEMA_VERSION = 1 as const;

export type LineMapArtifact = 'program' | 'fragment';
export type LineMapCompileArtifact = LineMapArtifact | 'none';
export type LineMapKind =
  'stmt' | 'prologue' | 'epilogue' | 'call' | 'data' | 'startup' | 'runtime';

export interface CompilerLineMapEntry {
  readonly cLine: number | null;
  readonly asmStart: number;
  readonly asmEnd: number;
  readonly kind: LineMapKind;
}

export interface LineMapCompileResult {
  readonly ok: boolean;
  readonly asm: string;
  readonly artifact: LineMapCompileArtifact;
  readonly lineMap: readonly CompilerLineMapEntry[];
}

export interface LineMapProjectionInput {
  readonly compilerVersion: string;
  readonly sourcePath: string;
  readonly sourceBytes: Uint8Array;
  readonly assemblyPath: string | null;
  readonly compileResult: LineMapCompileResult;
}

export interface LineMapSourceDto {
  readonly path: string;
  readonly sha256: string;
}

export interface LineMapAssemblyDto {
  readonly path: string | null;
  readonly sha256: string;
  readonly lineCount: number;
}

export interface LineMapEntryDto {
  readonly cLine: number | null;
  readonly asmStart: number;
  readonly asmEnd: number;
  readonly kind: LineMapKind;
}

export interface Lc3ccLineMapV1 {
  readonly format: typeof LINE_MAP_FORMAT;
  readonly schemaVersion: typeof LINE_MAP_SCHEMA_VERSION;
  readonly compilerVersion: string;
  readonly artifact: LineMapArtifact;
  readonly source: LineMapSourceDto;
  readonly assembly: LineMapAssemblyDto;
  readonly mappings: readonly LineMapEntryDto[];
}

export interface LineMapSidecar {
  readonly dto: Lc3ccLineMapV1;
  readonly json: string;
}

function fail(message: string): never {
  throw new TypeError(`lc3cc line map: ${message}`);
}

function assertNever(value: never, field: string): never {
  return fail(`unsupported ${field}: ${String(value)}`);
}

function publishedArtifact(artifact: LineMapCompileArtifact): LineMapArtifact {
  switch (artifact) {
    case 'program':
    case 'fragment':
      return artifact;
    case 'none':
      return fail('a compile with artifact "none" cannot produce a sidecar');
    default:
      return assertNever(artifact, 'artifact');
  }
}

function publishedMappingKind(kind: LineMapKind): LineMapKind {
  switch (kind) {
    case 'stmt':
    case 'prologue':
    case 'epilogue':
    case 'call':
    case 'data':
    case 'startup':
    case 'runtime':
      return kind;
    default:
      return assertNever(kind, 'mapping kind');
  }
}

function assemblyLineCount(assembly: string): number {
  return assembly === '' ? 0 : assembly.split('\n').length;
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashAssembly(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}

function projectMapping(entry: CompilerLineMapEntry, lineCount: number): LineMapEntryDto {
  if (typeof entry !== 'object' || entry === null) fail('each mapping must be an object');

  const { cLine, asmStart, asmEnd } = entry;
  if (cLine !== null && !isPositiveInteger(cLine)) {
    fail('mapping cLine must be null or a one-based integer');
  }
  if (!isPositiveInteger(asmStart) || !isPositiveInteger(asmEnd)) {
    fail('mapping assembly lines must be one-based integers');
  }
  if (asmEnd < asmStart) fail('mapping asmEnd must not precede asmStart');
  if (asmEnd > lineCount) fail('mapping range exceeds the emitted assembly');

  return Object.freeze({
    cLine,
    asmStart,
    asmEnd,
    kind: publishedMappingKind(entry.kind),
  });
}

export function projectLineMap(input: LineMapProjectionInput): Lc3ccLineMapV1 {
  if (typeof input !== 'object' || input === null) fail('projection input must be an object');
  if (typeof input.compilerVersion !== 'string' || input.compilerVersion.length === 0) {
    fail('compilerVersion must be a non-empty string');
  }
  if (typeof input.sourcePath !== 'string') fail('sourcePath must be a string');
  if (!(input.sourceBytes instanceof Uint8Array)) {
    fail('sourceBytes must contain the exact input bytes');
  }
  if (input.assemblyPath !== null && typeof input.assemblyPath !== 'string') {
    fail('assemblyPath must be a string or null');
  }

  const result = input.compileResult;
  if (typeof result !== 'object' || result === null) fail('compileResult must be an object');
  if (result.ok !== true) fail('only a successful compile can produce a sidecar');
  if (typeof result.asm !== 'string') fail('compileResult.asm must be a string');
  if (!Array.isArray(result.lineMap)) fail('compileResult.lineMap must be an array');

  const artifact = publishedArtifact(result.artifact);
  const lineCount = assemblyLineCount(result.asm);
  const mappings = Object.freeze(result.lineMap.map((entry) => projectMapping(entry, lineCount)));
  const source = Object.freeze({
    path: input.sourcePath,
    sha256: hashBytes(input.sourceBytes),
  });
  const assembly = Object.freeze({
    path: input.assemblyPath,
    sha256: hashAssembly(result.asm),
    lineCount,
  });

  return Object.freeze({
    format: LINE_MAP_FORMAT,
    schemaVersion: LINE_MAP_SCHEMA_VERSION,
    compilerVersion: input.compilerVersion,
    artifact,
    source,
    assembly,
    mappings,
  });
}

function assertExactDataFields(
  value: unknown,
  fields: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail(`${label} must be a plain object`);
  }
  if (!Object.isFrozen(value)) fail(`${label} must be frozen`);

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== fields.length ||
    ownKeys.some((key, index) => typeof key !== 'string' || key !== fields[index])
  ) {
    fail(`${label} has unexpected or reordered fields`);
  }

  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !descriptor.enumerable ||
      descriptor.configurable ||
      descriptor.writable
    ) {
      fail(`${label}.${field} must be a frozen JSON data field`);
    }
  }
}

function assertFrozenJsonArray(value: unknown, label: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be a plain array`);
  }
  if (!Object.isFrozen(value)) fail(`${label} must be frozen`);

  const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
  expectedKeys.push('length');
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key, index) => typeof key !== 'string' || key !== expectedKeys[index])
  ) {
    fail(`${label} must be a dense array without extra fields`);
  }

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      !descriptor.enumerable ||
      descriptor.configurable ||
      descriptor.writable
    ) {
      fail(`${label}[${index}] must be a frozen JSON data field`);
    }
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertSerializedArtifact(value: unknown): asserts value is LineMapArtifact {
  switch (value) {
    case 'program':
    case 'fragment':
      return;
    default:
      fail('artifact must be "program" or "fragment"');
  }
}

function assertSerializedKind(value: unknown): asserts value is LineMapKind {
  switch (value) {
    case 'stmt':
    case 'prologue':
    case 'epilogue':
    case 'call':
    case 'data':
    case 'startup':
    case 'runtime':
      return;
    default:
      fail('mapping kind is not part of schema version 1');
  }
}

function assertSerializableLineMap(value: unknown): asserts value is Lc3ccLineMapV1 {
  assertExactDataFields(
    value,
    ['format', 'schemaVersion', 'compilerVersion', 'artifact', 'source', 'assembly', 'mappings'],
    'document',
  );
  if (value.format !== LINE_MAP_FORMAT) fail('format is not lc3cc-line-map');
  if (value.schemaVersion !== LINE_MAP_SCHEMA_VERSION) fail('schemaVersion is not 1');
  if (typeof value.compilerVersion !== 'string' || value.compilerVersion.length === 0) {
    fail('compilerVersion must be a non-empty string');
  }
  assertSerializedArtifact(value.artifact);

  assertExactDataFields(value.source, ['path', 'sha256'], 'source');
  if (typeof value.source.path !== 'string') fail('source.path must be a string');
  assertHash(value.source.sha256, 'source.sha256');

  assertExactDataFields(value.assembly, ['path', 'sha256', 'lineCount'], 'assembly');
  if (value.assembly.path !== null && typeof value.assembly.path !== 'string') {
    fail('assembly.path must be a string or null');
  }
  assertHash(value.assembly.sha256, 'assembly.sha256');
  const lineCount = value.assembly.lineCount;
  if (typeof lineCount !== 'number' || !Number.isInteger(lineCount) || lineCount < 0) {
    fail('assembly.lineCount must be a non-negative integer');
  }

  assertFrozenJsonArray(value.mappings, 'mappings');
  for (let index = 0; index < value.mappings.length; index += 1) {
    const entry = value.mappings[index];
    assertExactDataFields(entry, ['cLine', 'asmStart', 'asmEnd', 'kind'], `mappings[${index}]`);
    if (entry.cLine !== null && !isPositiveInteger(entry.cLine)) {
      fail(`mappings[${index}].cLine must be null or a one-based integer`);
    }
    if (!isPositiveInteger(entry.asmStart) || !isPositiveInteger(entry.asmEnd)) {
      fail(`mappings[${index}] assembly lines must be one-based integers`);
    }
    if (entry.asmEnd < entry.asmStart) {
      fail(`mappings[${index}].asmEnd must not precede asmStart`);
    }
    if (entry.asmEnd > lineCount) {
      fail(`mappings[${index}] exceeds assembly.lineCount`);
    }
    assertSerializedKind(entry.kind);
  }
}

export function serializeLineMap(value: unknown): string {
  assertSerializableLineMap(value);
  const json = JSON.stringify(value, null, 2);
  if (typeof json !== 'string') fail('serialization did not produce JSON text');
  return `${json}\n`;
}

export function buildLineMapSidecar(input: LineMapProjectionInput): LineMapSidecar {
  const dto = projectLineMap(input);
  const json = serializeLineMap(dto);
  return Object.freeze({ dto, json });
}

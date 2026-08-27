import { createHash } from 'node:crypto';

import { compileC, type CcResult, type CLineMapEntry } from '../src/index.js';
import { describe, expect, test } from 'vitest';

import {
  buildLineMapSidecar,
  projectLineMap,
  serializeLineMap,
  type CompilerLineMapEntry,
  type LineMapCompileArtifact,
  type LineMapKind,
  type LineMapProjectionInput,
} from '../src/lineMap.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

const compilerArtifactArmsAreExact: Equal<CcResult['artifact'], LineMapCompileArtifact> = true;
const compilerMappingFieldsAreExact: Equal<Readonly<CLineMapEntry>, CompilerLineMapEntry> = true;
const compilerMappingArmsAreExact: Equal<CLineMapEntry['kind'], LineMapKind> = true;

const PROGRAM_SOURCE = 'int main(void) { return 0; }\n';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function projectionInput(overrides: Partial<LineMapProjectionInput> = {}): LineMapProjectionInput {
  return {
    compilerVersion: '1.0.0',
    sourcePath: 'input.c',
    sourceBytes: bytes(PROGRAM_SOURCE),
    assemblyPath: null,
    compileResult: {
      ok: true,
      asm: 'HALT',
      artifact: 'program',
      lineMap: [{ cLine: null, asmStart: 1, asmEnd: 1, kind: 'startup' }],
    },
    ...overrides,
  };
}

function expectPlainAndFrozen(value: unknown): void {
  if (Array.isArray(value)) {
    expect(Object.getPrototypeOf(value)).toBe(Array.prototype);
    expect(Object.isFrozen(value)).toBe(true);
    for (const entry of value) expectPlainAndFrozen(entry);
    return;
  }

  if (typeof value === 'object' && value !== null) {
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.isFrozen(value)).toBe(true);
    for (const entry of Object.values(value)) expectPlainAndFrozen(entry);
  }
}

describe('lc3cc line-map DTO and projector', () => {
  test('pins the compiler artifact and mapping unions exactly', () => {
    expect(compilerArtifactArmsAreExact).toBe(true);
    expect(compilerMappingFieldsAreExact).toBe(true);
    expect(compilerMappingArmsAreExact).toBe(true);
  });

  test('projects and serializes the exact v1 program schema deterministically', () => {
    const first = buildLineMapSidecar(projectionInput());
    const second = buildLineMapSidecar(projectionInput());

    expect(first.dto).toEqual({
      format: 'lc3cc-line-map',
      schemaVersion: 1,
      compilerVersion: '1.0.0',
      artifact: 'program',
      source: {
        path: 'input.c',
        sha256: '2ad75d95660563887d8d3f1d0ae1dcf18c2379cbd83a5c72f5ab276351ee6949',
      },
      assembly: {
        path: null,
        sha256: 'b19e5b8be7c5c491e472696f3486d82ce4d2d67150bdc5b648034e2ac3a40ad5',
        lineCount: 1,
      },
      mappings: [{ cLine: null, asmStart: 1, asmEnd: 1, kind: 'startup' }],
    });
    expect(first.json).toBe(`{
  "format": "lc3cc-line-map",
  "schemaVersion": 1,
  "compilerVersion": "1.0.0",
  "artifact": "program",
  "source": {
    "path": "input.c",
    "sha256": "2ad75d95660563887d8d3f1d0ae1dcf18c2379cbd83a5c72f5ab276351ee6949"
  },
  "assembly": {
    "path": null,
    "sha256": "b19e5b8be7c5c491e472696f3486d82ce4d2d67150bdc5b648034e2ac3a40ad5",
    "lineCount": 1
  },
  "mappings": [
    {
      "cLine": null,
      "asmStart": 1,
      "asmEnd": 1,
      "kind": "startup"
    }
  ]
}
`);
    expect(first.json).toBe(second.json);
    expect(first.json.endsWith('\n')).toBe(true);
    expect(first.json.endsWith('\n\n')).toBe(false);
    expectPlainAndFrozen(first.dto);
    expect(Object.isFrozen(first)).toBe(true);
  });

  test('preserves exact operand paths and owns every mapping-kind arm in compiler order', () => {
    const asm = ['STMT', 'PROLOGUE', 'EPILOGUE', 'CALL', 'DATA', 'STARTUP', 'RUNTIME'].join('\n');
    const sourceBytes = Uint8Array.of(0xff, 0x00, 0x41);
    const mappings: CLineMapEntry[] = [
      { cLine: 7, asmStart: 1, asmEnd: 1, kind: 'stmt' },
      { cLine: 7, asmStart: 2, asmEnd: 2, kind: 'prologue' },
      { cLine: 7, asmStart: 3, asmEnd: 3, kind: 'epilogue' },
      { cLine: 7, asmStart: 4, asmEnd: 4, kind: 'call' },
      { cLine: null, asmStart: 5, asmEnd: 5, kind: 'data' },
      { cLine: null, asmStart: 6, asmEnd: 6, kind: 'startup' },
      { cLine: null, asmStart: 7, asmEnd: 7, kind: 'runtime' },
    ];

    const dto = projectLineMap(
      projectionInput({
        sourcePath: './fixtures/../input.c',
        sourceBytes,
        assemblyPath: '../out/program.asm',
        compileResult: { ok: true, asm, artifact: 'fragment', lineMap: mappings },
      }),
    );

    expect(dto.artifact).toBe('fragment');
    expect(dto.source).toEqual({
      path: './fixtures/../input.c',
      sha256: sha256(sourceBytes),
    });
    expect(dto.assembly).toEqual({
      path: '../out/program.asm',
      sha256: sha256(asm),
      lineCount: 7,
    });
    expect(dto.mappings).toEqual(mappings);
    expect(dto.mappings).not.toBe(mappings);
    for (let index = 0; index < mappings.length; index += 1) {
      expect(dto.mappings[index]).not.toBe(mappings[index]);
    }
  });

  test('counts a trailing assembly newline as an additional physical split line', () => {
    const dto = projectLineMap(
      projectionInput({
        compileResult: {
          ok: true,
          asm: 'HALT\n',
          artifact: 'program',
          lineMap: [{ cLine: null, asmStart: 1, asmEnd: 1, kind: 'startup' }],
        },
      }),
    );

    expect(dto.assembly.lineCount).toBe(2);
  });

  test('projects a real complete compile without exposing fields outside the sidecar schema', () => {
    const direct = compileC(PROGRAM_SOURCE);
    const dto = projectLineMap(
      projectionInput({
        sourcePath: 'program.c',
        assemblyPath: 'program.asm',
        compileResult: direct,
      }),
    );

    expect(direct.ok).toBe(true);
    expect(direct.artifact).toBe('program');
    expect(dto.artifact).toBe(direct.artifact);
    expect(dto.assembly.sha256).toBe(sha256(direct.asm));
    expect(dto.assembly.lineCount).toBe(direct.asm.split('\n').length);
    expect(dto.mappings).toEqual(direct.lineMap);
    expect(Object.keys(dto)).toEqual([
      'format',
      'schemaVersion',
      'compilerVersion',
      'artifact',
      'source',
      'assembly',
      'mappings',
    ]);
    expect(dto).not.toHaveProperty('diagnostics');
    expect(dto).not.toHaveProperty('symbols');
    expect(dto).not.toHaveProperty('program');
    for (const entry of dto.mappings) {
      expect(entry.asmStart).toBeGreaterThanOrEqual(1);
      expect(entry.asmEnd).toBeGreaterThanOrEqual(entry.asmStart);
      expect(entry.asmEnd).toBeLessThanOrEqual(dto.assembly.lineCount);
    }
  });

  test('projects a real warning-bearing fragment as a fragment', () => {
    const source = 'int helper(void) { return 7; }\n';
    const direct = compileC(source);
    const dto = projectLineMap(
      projectionInput({
        sourcePath: 'helper.c',
        sourceBytes: bytes(source),
        compileResult: direct,
      }),
    );

    expect(direct.ok).toBe(true);
    expect(direct.artifact).toBe('fragment');
    expect(direct.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual(['warning']);
    expect(dto.artifact).toBe('fragment');
    expect(dto.mappings).toEqual(direct.lineMap);
  });

  test('owns the exact empty-success fragment semantics', () => {
    const direct = compileC('');
    const sidecar = buildLineMapSidecar(
      projectionInput({
        sourcePath: 'empty.c',
        sourceBytes: bytes(''),
        compileResult: direct,
      }),
    );

    expect(direct.ok).toBe(true);
    expect(direct.artifact).toBe('fragment');
    expect(direct.asm).toBe('');
    expect(direct.lineMap).toEqual([]);
    expect(sidecar.dto.artifact).toBe('fragment');
    expect(sidecar.dto.assembly).toEqual({
      path: null,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      lineCount: 0,
    });
    expect(sidecar.dto.mappings).toEqual([]);
  });

  test.each([
    ['failed compile', { ok: false, asm: '', artifact: 'none', lineMap: [] }],
    ['successful none artifact', { ok: true, asm: '', artifact: 'none', lineMap: [] }],
  ])('rejects %s rather than publishing a misleading sidecar', (_name, compileResult) => {
    expect(() =>
      projectLineMap(
        projectionInput({
          compileResult: compileResult as LineMapProjectionInput['compileResult'],
        }),
      ),
    ).toThrow();
  });

  test('rejects an unknown future artifact arm at runtime', () => {
    expect(() =>
      projectLineMap(
        projectionInput({
          compileResult: {
            ok: true,
            asm: 'HALT',
            artifact: 'library',
            lineMap: [],
          } as unknown as LineMapProjectionInput['compileResult'],
        }),
      ),
    ).toThrow(/artifact/);
  });

  test('rejects an unknown future mapping-kind arm at runtime', () => {
    expect(() =>
      projectLineMap(
        projectionInput({
          compileResult: {
            ok: true,
            asm: 'HALT',
            artifact: 'program',
            lineMap: [{ cLine: 1, asmStart: 1, asmEnd: 1, kind: 'future' }],
          } as unknown as LineMapProjectionInput['compileResult'],
        }),
      ),
    ).toThrow(/mapping kind/);
  });

  test.each([
    ['zero start', { cLine: 1, asmStart: 0, asmEnd: 1, kind: 'stmt' }],
    ['reversed range', { cLine: 1, asmStart: 1, asmEnd: 0, kind: 'stmt' }],
    ['out-of-bounds end', { cLine: 1, asmStart: 1, asmEnd: 2, kind: 'stmt' }],
    ['zero C line', { cLine: 0, asmStart: 1, asmEnd: 1, kind: 'stmt' }],
  ])('rejects a mapping with %s', (_name, entry) => {
    expect(() =>
      projectLineMap(
        projectionInput({
          compileResult: {
            ok: true,
            asm: 'HALT',
            artifact: 'program',
            lineMap: [entry],
          } as LineMapProjectionInput['compileResult'],
        }),
      ),
    ).toThrow(/mapping/);
  });

  test('rejects mappings for an empty assembly artifact', () => {
    expect(() =>
      projectLineMap(
        projectionInput({
          compileResult: {
            ok: true,
            asm: '',
            artifact: 'fragment',
            lineMap: [{ cLine: 1, asmStart: 1, asmEnd: 1, kind: 'stmt' }],
          },
        }),
      ),
    ).toThrow(/mapping/);
  });

  test('serialization fails closed on non-plain, non-frozen, or extended DTOs', () => {
    const dto = projectLineMap(projectionInput());
    const unfrozen = { ...dto };
    const nonPlain = Object.freeze(Object.assign(Object.create(null), dto));
    const extended = Object.freeze({ ...dto, diagnostics: [] });

    expect(() => serializeLineMap(unfrozen)).toThrow(/frozen/);
    expect(() => serializeLineMap(nonPlain)).toThrow(/plain/);
    expect(() => serializeLineMap(extended)).toThrow(/fields/);
  });
});

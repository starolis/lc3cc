import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { compileC, type CLineMapEntry } from '../src/index.js';

interface GoldenCase {
  readonly artifact: 'program' | 'fragment';
  readonly assembly: string;
  readonly diagnostics: readonly ('error' | 'warning')[];
  readonly lineMap: readonly CLineMapEntry[];
  readonly source: string;
}

function readFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

function readAssemblyGolden(name: string): string {
  const text = readFixture(name);
  expect(text.endsWith('\n')).toBe(true);
  expect(text.endsWith('\n\n')).toBe(false);
  return text.slice(0, -1);
}

const CASES: readonly GoldenCase[] = [
  {
    artifact: 'program',
    assembly: 'minimal.asm',
    diagnostics: [],
    source: 'minimal.c',
    lineMap: [
      { cLine: null, asmStart: 2, asmEnd: 10, kind: 'startup' },
      { cLine: null, asmStart: 11, asmEnd: 12, kind: 'data' },
      { cLine: 1, asmStart: 14, asmEnd: 20, kind: 'prologue' },
      { cLine: 1, asmStart: 21, asmEnd: 22, kind: 'stmt' },
      { cLine: 1, asmStart: 23, asmEnd: 24, kind: 'epilogue' },
      { cLine: 1, asmStart: 26, asmEnd: 31, kind: 'epilogue' },
      { cLine: null, asmStart: 33, asmEnd: 33, kind: 'data' },
    ],
  },
  {
    artifact: 'fragment',
    assembly: 'fragment.asm',
    diagnostics: ['warning'],
    source: 'fragment.c',
    lineMap: [
      { cLine: 1, asmStart: 2, asmEnd: 8, kind: 'prologue' },
      { cLine: 1, asmStart: 9, asmEnd: 14, kind: 'stmt' },
      { cLine: 1, asmStart: 15, asmEnd: 16, kind: 'epilogue' },
      { cLine: 1, asmStart: 18, asmEnd: 23, kind: 'epilogue' },
    ],
  },
];

describe('assembly output goldens', () => {
  test.each(CASES)('keeps $source output and line mappings stable', (fixture) => {
    const result = compileC(readFixture(fixture.source));

    expect(result.ok).toBe(true);
    expect(result.artifact).toBe(fixture.artifact);
    expect(result.diagnostics.map(({ severity }) => severity)).toEqual(fixture.diagnostics);
    expect(result.asm).toBe(readAssemblyGolden(fixture.assembly));
    expect(result.lineMap).toEqual(fixture.lineMap);
  });
});

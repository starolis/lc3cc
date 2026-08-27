import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import * as registry from '../src/features.js';
import type { FeatureInfo, FeatureStatus } from '../src/features.js';

const EXPECTED_FEATURES = [
  'array-brace-initializer',
  'auto',
  'bare-struct-forward',
  'block-scope-type-declaration',
  'calloc',
  'cast-beyond-malloc-result',
  'double',
  'enum',
  'extern',
  'float',
  'float-conversion',
  'gets',
  'goto',
  'long',
  'pointer-relational',
  'pointer-subtraction',
  'puts',
  'realloc',
  'register',
  'scanf-conversion',
  'short',
  'signed',
  'sizeof-expression',
  'static',
  'string-literal-context',
  'struct-assignment',
  'struct-by-value-argument',
  'struct-member-array',
  'struct-return',
  'struct-typed-member',
  'tagless-struct-typedef',
  'typedef-name-shadowing',
  'union',
  'unsigned',
  'unspecified-array-dimension',
  'variable-length-array',
  'variadic',
  'void-pointer-arithmetic',
  'void-pointer-type',
  'volatile',
] as const;

const STATUS_IS_EXACT: FeatureStatus = 'out-of-scope';

function isFeatureInfo(value: unknown): value is FeatureInfo {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<FeatureInfo>;
  return (
    typeof candidate.feature === 'string' &&
    candidate.status === 'out-of-scope' &&
    typeof candidate.message === 'string'
  );
}

function featureEntries(): FeatureInfo[] {
  const entries = Object.values(registry).flatMap((value) => {
    if (isFeatureInfo(value)) return [value];
    if (typeof value !== 'object' || value === null) return [];
    return Object.values(value).filter(isFeatureInfo);
  });
  return [...new Map(entries.map((entry) => [entry.feature, entry])).values()];
}

function documentedFeatureKeys(): string[] {
  const markdown = readFileSync(new URL('../docs/c-subset.md', import.meta.url), 'utf8');
  const registrySection = markdown.match(
    /<!-- feature-registry:start -->([\s\S]*?)<!-- feature-registry:end -->/,
  )?.[1];
  if (registrySection === undefined)
    throw new Error('C subset feature registry markers are missing');
  return [...registrySection.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1]!);
}

describe('out-of-scope feature registry', () => {
  test('owns the exact v1 keys and status', () => {
    const entries = featureEntries();

    expect(STATUS_IS_EXACT).toBe('out-of-scope');
    expect(entries.map(({ feature }) => feature).sort()).toEqual([...EXPECTED_FEATURES].sort());
    expect(entries.every(({ status }) => status === 'out-of-scope')).toBe(true);
    expect(entries.every(({ message }) => message.length > 0)).toBe(true);
  });

  test('matches the public C subset table exactly', () => {
    expect(documentedFeatureKeys()).toEqual([...EXPECTED_FEATURES]);
  });
});

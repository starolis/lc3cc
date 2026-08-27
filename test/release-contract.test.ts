import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { compileC } from '../src/index.js';
import { buildLineMapSidecar } from '../src/lineMap.js';

interface PackageManifest {
  readonly bin: { readonly lc3cc: string };
  readonly bugs: { readonly url: string };
  readonly dependencies: Record<string, string>;
  readonly description: string;
  readonly devDependencies: Record<string, string>;
  readonly engines: { readonly node: string };
  readonly exports: { readonly '.': { readonly import: string; readonly types: string } };
  readonly files: readonly string[];
  readonly homepage: string;
  readonly license: string;
  readonly main: string;
  readonly name: string;
  readonly private: boolean;
  readonly publishConfig: {
    readonly access: string;
    readonly provenance: boolean;
    readonly registry: string;
  };
  readonly repository: { readonly type: string; readonly url: string };
  readonly scripts: Record<string, string>;
  readonly type: string;
  readonly types: string;
  readonly version: string;
}

interface PackageLock {
  readonly lockfileVersion: number;
  readonly name: string;
  readonly packages: Record<string, Record<string, unknown>>;
  readonly requires: boolean;
  readonly version: string;
}

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRECTORY = resolve(PACKAGE_ROOT, 'src');
const TEST_DIRECTORY = resolve(PACKAGE_ROOT, 'test');

const EXPECTED_PRODUCTION_SOURCES = [
  'ast.ts',
  'bin.ts',
  'check.ts',
  'cli.ts',
  'codegen.ts',
  'compile.ts',
  'diagnostics.ts',
  'features.ts',
  'index.ts',
  'int16.ts',
  'lexer.ts',
  'lineMap.ts',
  'parser.ts',
  'runtime.ts',
  'scopes.ts',
  'symbols.ts',
  'tokens.ts',
] as const;

const EXPECTED_TESTS = [
  'assembly.test.ts',
  'cli-map.test.ts',
  'cli.test.ts',
  'compiler.test.ts',
  'features.test.ts',
  'line-map.test.ts',
  'public-api.test.ts',
  'release-contract.test.ts',
] as const;

const EXPECTED_FIXTURES = ['fragment.asm', 'fragment.c', 'minimal.asm', 'minimal.c'] as const;

const EXPECTED_SCRIPTS = {
  build: 'tsc -p tsconfig.json',
  test: 'vitest run',
  typecheck: 'tsc -p tsconfig.test.json',
  lint: 'eslint .',
  format: 'prettier --write .',
  'format:check': 'prettier --check .',
  'content:check':
    'node --test scripts/check-book-ip.test.mjs && node scripts/check-book-ip.mjs --root . && node scripts/check-book-ip.mjs --root . --history',
  'package:check': 'node --test scripts/check-package.test.mjs && node scripts/check-package.mjs',
} as const;

const EXPECTED_DEV_DEPENDENCIES = {
  '@types/node': '^24.0.0',
  eslint: '^9.30.0',
  prettier: '^3.6.0',
  typescript: '^5.9.0',
  'typescript-eslint': '^8.35.0',
  vitest: '^4.1.10',
} as const;

const EXPECTED_PACKAGE_FILES = [
  'dist',
  'docs',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
] as const;

const EXPECTED_PACKAGE_KEYS = [
  'bin',
  'bugs',
  'dependencies',
  'description',
  'devDependencies',
  'engines',
  'exports',
  'files',
  'homepage',
  'license',
  'main',
  'name',
  'private',
  'publishConfig',
  'repository',
  'scripts',
  'type',
  'types',
  'version',
] as const;

const EXPECTED_ACTIONS = [
  'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
  'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
] as const;

const EXPECTED_WORKFLOWS = ['ci.yml', 'publish.yml'] as const;
const PRIVATE_REPORT_URL = 'https://github.com/starolis/lc3cc/security/advisories/new';
const EXPECTED_TAR_SHA256 = 'd8df4ceb870d0375cd2ed4bea710ef32b8f0bc20ecc707a095090258b0720e8f';

const MARKDOWN_FILES = [
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'README.md',
  'SECURITY.md',
  'docs/c-subset.md',
  'docs/line-map.md',
] as const;

function readPackageManifest(): PackageManifest {
  return JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')) as PackageManifest;
}

function readPackageLock(): PackageLock {
  return JSON.parse(
    readFileSync(resolve(PACKAGE_ROOT, 'package-lock.json'), 'utf8'),
  ) as PackageLock;
}

function includedInPackage(path: string, files: readonly string[]): boolean {
  const normalized = path.split(sep).join('/');
  return files.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

function localMarkdownLinks(markdownPath: string): string[] {
  const absolutePath = resolve(PACKAGE_ROOT, markdownPath);
  const markdown = readFileSync(absolutePath, 'utf8');
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1]!)
    .filter((target) => !target.startsWith('#') && !/^[a-z]+:/i.test(target))
    .map((target) => relative(PACKAGE_ROOT, resolve(dirname(absolutePath), target)));
}

function fencedBlock(markdown: string, language: string): string {
  const opening = ['```', language, '\n'].join('');
  const sections = markdown.split(opening);
  if (sections.length !== 2) {
    throw new Error(`expected exactly one ${language} fence`);
  }
  const closing = sections[1]!.indexOf('```');
  if (closing === -1) throw new Error(`missing closing ${language} fence`);
  return sections[1]!.slice(0, closing);
}

describe('standalone release contract', () => {
  test('pins the complete production and public test rosters', () => {
    const productionSources = readdirSync(SOURCE_DIRECTORY)
      .filter((name) => name.endsWith('.ts'))
      .sort();
    const tests = readdirSync(TEST_DIRECTORY)
      .filter((name) => name.endsWith('.test.ts'))
      .sort();
    const fixtures = readdirSync(resolve(TEST_DIRECTORY, 'fixtures')).sort();

    expect(productionSources).toEqual([...EXPECTED_PRODUCTION_SOURCES]);
    expect(tests).toEqual([...EXPECTED_TESTS]);
    expect(fixtures).toEqual([...EXPECTED_FIXTURES]);
  });

  test('is release-ready and dependency-free with the exact development commands', () => {
    const manifest = readPackageManifest();
    const changelog = readFileSync(resolve(PACKAGE_ROOT, 'CHANGELOG.md'), 'utf8');
    const readme = readFileSync(resolve(PACKAGE_ROOT, 'README.md'), 'utf8');
    const security = readFileSync(resolve(PACKAGE_ROOT, 'SECURITY.md'), 'utf8');

    expect(Object.keys(manifest).sort()).toEqual([...EXPECTED_PACKAGE_KEYS].sort());
    expect(manifest.name).toBe('lc3cc');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.private).toBe(false);
    expect(manifest.publishConfig).toEqual({
      access: 'public',
      provenance: true,
      registry: 'https://registry.npmjs.org/',
    });
    expect(manifest.description).toBe('C-to-LC-3 compiler and TypeScript library');
    expect(manifest.license).toBe('MIT');
    expect(manifest.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/starolis/lc3cc.git',
    });
    expect(manifest.bugs).toEqual({ url: 'https://github.com/starolis/lc3cc/issues' });
    expect(manifest.homepage).toBe('https://github.com/starolis/lc3cc#readme');
    expect(manifest.type).toBe('module');
    expect(manifest.main).toBe('./dist/index.js');
    expect(manifest.types).toBe('./dist/index.d.ts');
    expect(manifest.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    });
    expect(manifest.bin).toEqual({ lc3cc: './dist/bin.js' });
    expect(manifest.files).toEqual(EXPECTED_PACKAGE_FILES);
    expect(manifest.dependencies).toEqual({});
    expect(manifest.devDependencies).toEqual(EXPECTED_DEV_DEPENDENCIES);
    expect(manifest.engines.node).toBe('^22.0.0 || ^24.0.0 || ^26.0.0');
    expect(manifest.scripts).toEqual(EXPECTED_SCRIPTS);
    expect(manifest).not.toHaveProperty('peerDependencies');
    expect(manifest).not.toHaveProperty('optionalDependencies');
    expect(manifest).not.toHaveProperty('bundledDependencies');
    for (const lifecycle of [
      'preinstall',
      'install',
      'postinstall',
      'prepare',
      'prepack',
      'postpack',
      'prepublish',
      'prepublishOnly',
      'publish',
      'postpublish',
    ]) {
      expect(manifest.scripts).not.toHaveProperty(lifecycle);
    }
    expect(existsSync(resolve(PACKAGE_ROOT, 'NOT-PUBLISHABLE'))).toBe(false);
    expect(changelog).toContain('## 1.0.0 - 2026-08-27');
    expect(changelog).not.toContain('## Unreleased');
    expect(security).toContain('| `1.0.x` | Yes');
    expect(security).toContain(PRIVATE_REPORT_URL);
    expect(readme).not.toMatch(/not released yet|Install after release/);
  });

  test('locks the exact root development surface without runtime or lifecycle edges', () => {
    const manifest = readPackageManifest();
    const lock = readPackageLock();
    const root = lock.packages[''];

    expect(Object.keys(lock).sort()).toEqual([
      'lockfileVersion',
      'name',
      'packages',
      'requires',
      'version',
    ]);
    expect(lock.name).toBe(manifest.name);
    expect(lock.version).toBe(manifest.version);
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.requires).toBe(true);
    expect(root).toEqual({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      bin: { lc3cc: 'dist/bin.js' },
      devDependencies: manifest.devDependencies,
      engines: manifest.engines,
    });
    expect(root).not.toHaveProperty('dependencies');
    expect(root).not.toHaveProperty('optionalDependencies');
    expect(root).not.toHaveProperty('peerDependencies');
    expect(root).not.toHaveProperty('bundledDependencies');
    expect(root).not.toHaveProperty('scripts');
    expect(
      Object.entries(lock.packages)
        .filter(([path]) => path !== '')
        .every(([, record]) => record.dev === true),
    ).toBe(true);
  });

  test('owns one main-only matrix job with immutable actions and Node 24-only static checks', () => {
    const workflowDirectory = resolve(PACKAGE_ROOT, '.github/workflows');
    const workflows = readdirSync(workflowDirectory).sort();
    const ci = readFileSync(resolve(workflowDirectory, 'ci.yml'), 'utf8');
    const jobs = ci.slice(ci.indexOf('\njobs:\n') + 7);
    const jobNames = [...jobs.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]!);
    const actionRefs = [...ci.matchAll(/^\s*- uses: (\S+)(?:\s+#.*)?$/gm)].map(
      (match) => match[1]!,
    );
    const matrixMatch = ci.match(/^\s*node: \[([^\]]+)\]$/m);
    const matrix = matrixMatch?.[1].split(',').map((entry) => Number(entry.trim()));
    const conditionalCommands = [
      ...ci.matchAll(/^\s*- if: matrix\.node == 24\n\s+run: (npm run \S+)$/gm),
    ].map((match) => match[1]!);

    expect(workflows).toEqual([...EXPECTED_WORKFLOWS]);
    expect(ci).toContain(
      'on:\n  pull_request:\n    branches: [main]\n  push:\n    branches: [main]\n',
    );
    expect(ci).toContain('permissions:\n  contents: read\n');
    expect(jobNames).toEqual(['test']);
    expect(matrix).toEqual([22, 24, 26]);
    expect(actionRefs).toEqual(EXPECTED_ACTIONS);
    expect(ci).toContain('node-version: ${{ matrix.node }}');
    expect([...ci.matchAll(/^\s*- run: npm ci --ignore-scripts$/gm)]).toHaveLength(1);
    expect([...ci.matchAll(/^\s*- run: npm run build$/gm)]).toHaveLength(1);
    expect([...ci.matchAll(/^\s*- run: npm test$/gm)]).toHaveLength(1);
    expect(conditionalCommands).toEqual([
      'npm run content:check',
      'npm run typecheck',
      'npm run lint',
      'npm run format:check',
      'npm run package:check',
    ]);
    expect(ci).toContain('fetch-depth: 0');
    expect(ci).toContain('persist-credentials: false');
    expect(ci).not.toMatch(/actions\/(?:checkout|setup-node)@v\d/);
    expect(ci).not.toMatch(/npm\s+(?:publish|pack)|release|registry\.npmjs\.org/i);
  });

  test('publishes only by explicit tag dispatch with exact artifact and provenance gates', () => {
    const publish = readFileSync(resolve(PACKAGE_ROOT, '.github/workflows/publish.yml'), 'utf8');
    const actionRefs = [...publish.matchAll(/^\s*- uses: (\S+)(?:\s+#.*)?$/gm)].map(
      (match) => match[1]!,
    );
    const secretReferences = [...publish.matchAll(/secrets\.[A-Za-z_][A-Za-z0-9_]*/g)].map(
      (match) => match[0]!,
    );

    expect(publish).toContain('on:\n  workflow_dispatch:\n');
    expect(publish).toContain('permissions:\n  contents: read\n  id-token: write\n');
    expect(publish).toContain('environment: npm');
    expect(actionRefs).toEqual(EXPECTED_ACTIONS);
    expect(publish).toContain('node-version: 24.19.0');
    expect(publish).toContain('package-manager-cache: false');
    expect(publish.indexOf('npm run content:check')).toBeLessThan(
      publish.indexOf('npm ci --ignore-scripts'),
    );
    expect(publish).toContain('npm view "lc3cc@${version}" version');
    expect(publish).toContain("grep -q 'E404'");
    expect(publish).toContain(EXPECTED_TAR_SHA256);
    expect([...publish.matchAll(/npm publish /g)]).toHaveLength(1);
    expect(publish).toContain('--provenance --access public');
    expect(secretReferences).toEqual([]);
    expect(publish).not.toContain(['NODE', 'AUTH', 'TOKEN'].join('_'));
    expect(publish).not.toMatch(/pull_request|pull_request_target|workflow_run|^\s*push:\s*$/m);
    expect(publish).not.toMatch(/actions\/(?:checkout|setup-node)@v\d/);
  });

  test('keeps every local documentation link present and package-included', () => {
    const manifest = readPackageManifest();
    const targets = MARKDOWN_FILES.flatMap(localMarkdownLinks);

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.startsWith('..')).toBe(false);
      expect(existsSync(resolve(PACKAGE_ROOT, target))).toBe(true);
      expect(statSync(resolve(PACKAGE_ROOT, target)).isFile()).toBe(true);
      expect(includedInPackage(target, manifest.files)).toBe(true);
    }
  });

  test('executes the exact fenced line-map example and matches every emitted field', () => {
    const markdown = readFileSync(resolve(PACKAGE_ROOT, 'docs/line-map.md'), 'utf8');
    const source = fencedBlock(markdown, 'c');
    const documentedJson = fencedBlock(markdown, 'json');
    const documented = JSON.parse(documentedJson) as Record<string, unknown>;
    const compiled = compileC(source);

    expect(compiled.ok).toBe(true);
    expect(compiled.artifact).toBe('program');

    const generated = buildLineMapSidecar({
      compilerVersion: readPackageManifest().version,
      sourcePath: 'input.c',
      sourceBytes: new TextEncoder().encode(source),
      assemblyPath: 'output.asm',
      compileResult: compiled,
    });

    expect(documentedJson).toBe(generated.json);
    expect(documented).toEqual(generated.dto);
    expect(documented).toMatchObject({
      format: 'lc3cc-line-map',
      schemaVersion: 1,
      artifact: compiled.artifact,
      source: { path: 'input.c' },
      assembly: {
        path: 'output.asm',
        lineCount: compiled.asm.split('\n').length,
      },
      mappings: compiled.lineMap,
    });
    expect(compiled.lineMap.some((entry) => entry.kind === 'startup')).toBe(true);
  });
});

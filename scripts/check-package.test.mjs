import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  PACKAGE_FILES,
  PRODUCTION_BASENAMES,
  assertExactTarballPaths,
  assertPackedModuleClosure,
  assertSafePackageManifest,
  checkPackage,
  expectedTarballPaths,
} from './check-package.mjs';

function safeManifest(overrides = {}) {
  return {
    dependencies: {},
    scripts: { build: 'tsc -p tsconfig.json' },
    ...overrides,
  };
}

function embeddedSourceMap(path) {
  const basename = path.slice('dist/'.length, -'.js.map'.length);
  return `${JSON.stringify({
    version: 3,
    file: `${basename}.js`,
    sourceRoot: '',
    sources: [`../src/${basename}.ts`],
    names: [],
    mappings: '',
    sourcesContent: ['export {};\n'],
  })}\n`;
}

function externalSourceMap(sourceRoot, source, sourceContent = null) {
  return `${JSON.stringify({
    version: 3,
    file: 'index.js',
    sourceRoot,
    sources: [source],
    names: [],
    mappings: '',
    sourcesContent: [sourceContent],
  })}\n`;
}

function withPackageFixture(mutations, callback) {
  const root = mkdtempSync(join(tmpdir(), 'lc3cc-package-check-test-'));
  try {
    const contents = new Map(
      expectedTarballPaths().map((path) => {
        if (path === 'package.json') {
          return [
            path,
            `${JSON.stringify(
              {
                name: 'lc3cc-package-check-fixture',
                version: '1.0.0',
                type: 'module',
                files: [
                  'dist',
                  'docs',
                  'CHANGELOG.md',
                  'CONTRIBUTING.md',
                  'LICENSE',
                  'README.md',
                  'SECURITY.md',
                ],
                dependencies: {},
                scripts: { build: 'tsc -p tsconfig.json' },
              },
              null,
              2,
            )}\n`,
          ];
        }
        if (path === 'LICENSE') {
          return [path, readFileSync(new URL('../LICENSE', import.meta.url))];
        }
        if (path.endsWith('.js')) return [path, 'export {};\n'];
        if (path.endsWith('.d.ts')) return [path, 'export {};\n'];
        if (path.endsWith('.js.map')) return [path, embeddedSourceMap(path)];
        return [path, `${path}\n`];
      }),
    );
    for (const [path, content] of Object.entries(mutations)) contents.set(path, content);
    for (const [path, content] of contents) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

test('the allowlist is exactly 17 production basenames times three build files plus package files', () => {
  const expected = expectedTarballPaths();

  assert.equal(PRODUCTION_BASENAMES.length, 17);
  assert.equal(PACKAGE_FILES.length, 9);
  assert.equal(expected.length, 60);
  assert.deepEqual(
    expected.filter((path) => path.startsWith('dist/')),
    PRODUCTION_BASENAMES.flatMap((basename) => [
      `dist/${basename}.d.ts`,
      `dist/${basename}.js`,
      `dist/${basename}.js.map`,
    ]).sort(),
  );
});

test('the exact allowlist passes in any order', () => {
  assert.doesNotThrow(() => assertExactTarballPaths(expectedTarballPaths().reverse()));
});

test('a broad dist include cannot smuggle an unreviewed build file', () => {
  assert.throws(
    () => assertExactTarballPaths([...expectedTarballPaths(), 'dist/unreviewed.js']),
    /unexpected: dist\/unreviewed\.js/,
  );
});

test('missing, duplicate, and escaping paths fail closed', () => {
  const expected = expectedTarballPaths();
  assert.throws(() => assertExactTarballPaths(expected.slice(1)), /missing:/);
  assert.throws(() => assertExactTarballPaths([...expected, expected[0]]), /duplicate paths/);
  assert.throws(() => assertExactTarballPaths([...expected, '../outside']), /unsafe path/);
});

test('runtime dependency fields fail when nonempty', () => {
  for (const [field, value] of [
    ['dependencies', { package: '1.0.0' }],
    ['optionalDependencies', { package: '1.0.0' }],
    ['peerDependencies', { package: '1.0.0' }],
    ['bundledDependencies', ['package']],
    ['bundleDependencies', ['package']],
  ]) {
    assert.throws(
      () => assertSafePackageManifest(safeManifest({ [field]: value })),
      new RegExp(`${field} must be empty`),
    );
  }
});

test('package lifecycle scripts fail while ordinary development scripts remain allowed', () => {
  assert.doesNotThrow(() => assertSafePackageManifest(safeManifest()));
  for (const lifecycle of ['install', 'prepare', 'prepack', 'prepublishOnly', 'publish']) {
    assert.throws(
      () =>
        assertSafePackageManifest(
          safeManifest({ scripts: { build: 'tsc -p tsconfig.json', [lifecycle]: 'unexpected' } }),
        ),
      new RegExp(`package lifecycle scripts are not allowed: ${lifecycle}`),
    );
  }
});

test('the reviewed license and relative or node-only packed closure pass together', () => {
  withPackageFixture(
    {
      'dist/index.js':
        "import { readFile } from 'node:fs/promises';\nexport * from './compile.js';\n",
      'dist/index.d.ts': "export type { CompileResult } from './compile.js';\n",
      'dist/compile.d.ts': 'export interface CompileResult { readonly assembly: string; }\n',
    },
    (root) => assert.doesNotThrow(() => checkPackage(root)),
  );
});

test('every packed source map is parseable and self-contained', () => {
  withPackageFixture({ 'dist/index.js.map': '{not json}\n' }, (root) => {
    assert.throws(() => checkPackage(root), /dist\/index\.js\.map.*valid JSON/);
  });

  withPackageFixture(
    {
      'dist/index.js.map': `${JSON.stringify({
        version: 3,
        file: 'index.js',
        sourceRoot: '',
        sources: ['../src/index.ts'],
        names: [],
        mappings: '',
      })}\n`,
    },
    (root) => {
      assert.throws(
        () => checkPackage(root),
        /dist\/index\.js\.map.*source.*not embedded or packed/,
      );
    },
  );

  withPackageFixture(
    {
      'dist/index.js.map': `${JSON.stringify({
        version: 3,
        file: 'index.js',
        sourceRoot: '',
        sources: ['../src/index.ts'],
        names: [],
        mappings: '',
        sourcesContent: [],
      })}\n`,
    },
    (root) => {
      assert.throws(() => checkPackage(root), /dist\/index\.js\.map.*pair each source/);
    },
  );

  withPackageFixture(
    {
      'dist/index.js.map': `${JSON.stringify({
        version: 3,
        file: 'index.js',
        sourceRoot: '',
        sources: [],
        names: [],
        mappings: '',
      })}\n`,
    },
    (root) => {
      assert.throws(() => checkPackage(root), /dist\/index\.js\.map.*at least one source/);
    },
  );
});

test('source-map paths cannot disguise absolute, URL, or non-portable targets', () => {
  for (const [name, sourceRoot, source] of [
    ['absolute source after a relative root', '.', '/index.js'],
    ['absolute source root', '/src', 'index.ts'],
    ['URL source', '', 'https://example.invalid/index.ts'],
    ['scheme source root', 'file:///src', 'index.ts'],
    ['protocol-relative source', '', '//example.invalid/index.ts'],
    ['backslash source', '', '..\\src\\index.ts'],
    ['encoded separator', '', '..%2fsrc/index.ts'],
    ['encoded dot segment', '', '%2e%2e/src/index.ts'],
    ['query-bearing source', '', '../src/index.ts?raw'],
  ]) {
    withPackageFixture({ 'dist/index.js.map': externalSourceMap(sourceRoot, source) }, (root) => {
      assert.throws(() => checkPackage(root), /portable relative source-map path/, name);
    });
  }
});

test('embedded source-map paths must be trim-stable', () => {
  for (const source of [' https://example.invalid/index.ts', '../src/index.ts ']) {
    withPackageFixture(
      {
        'dist/index.js.map': externalSourceMap('', source, 'export {};\n'),
      },
      (root) => {
        assert.throws(() => checkPackage(root), /portable relative source-map path/);
      },
    );
  }
});

test('a relative sourceRoot may resolve to an explicitly packed source', () => {
  withPackageFixture(
    {
      'dist/index.js.map': externalSourceMap('../src', 'index.ts'),
      'src/index.ts': 'export {};\n',
    },
    (root) => {
      assert.doesNotThrow(() =>
        assertPackedModuleClosure(root, [...expectedTarballPaths(), 'src/index.ts']),
      );
    },
  );
});

test('a bare production import fails the package gate before a clean install can break', () => {
  withPackageFixture({ 'dist/index.js': "import 'typescript';\n" }, (root) => {
    assert.throws(() => checkPackage(root), /external package import.*typescript/);
  });
});

test('declarations cannot retain external package or escaping path references', () => {
  for (const [path, source, expected] of [
    ['dist/index.d.ts', "import type { CompilerOptions } from 'typescript';\n", /typescript/],
    [
      'dist/index.d.ts',
      '/// <reference types="typescript" />\nexport {};\n',
      /type package.*typescript/,
    ],
    ['dist/index.d.ts', '/// <reference types="node" />\nexport {};\n', /type package.*node/],
    [
      'dist/index.d.ts',
      "import type { PathLike } from 'node:fs';\nexport type Input = PathLike;\n",
      /node type module.*node:fs/,
    ],
    [
      'dist/index.d.ts',
      '/// <reference path="./not-packed.d.ts" />\nexport {};\n',
      /outside the packed module closure/,
    ],
  ]) {
    withPackageFixture({ [path]: source }, (root) => {
      assert.throws(() => checkPackage(root), expected);
    });
  }
});

test('node module loader primitives cannot reopen the zero-dependency closure', () => {
  withPackageFixture(
    {
      'dist/index.js': [
        "import { createRequire } from 'node:module';",
        'const loaders = { load: createRequire(import.meta.url) };',
        "loaders.load('typescript');",
        '',
      ].join('\n'),
    },
    (root) => {
      assert.throws(() => checkPackage(root), /disallowed module loader primitive/);
    },
  );
});

test('drift from the reviewed MIT license bytes fails the package gate', () => {
  const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
  withPackageFixture({ LICENSE: license.replace('MIT License', 'ISC License') }, (root) => {
    assert.throws(() => checkPackage(root), /LICENSE.*reviewed MIT license/);
  });
});

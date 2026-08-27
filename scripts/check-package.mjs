// Verify the exact npm tarball boundary without creating or publishing an
// archive. The build must already exist; npm reports the same selected files
// it would pack, and this script rejects any missing or additional member.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const REVIEWED_LICENSE_SHA256 =
  '3e727da3cd485a2b968ce90057a7a0e18e113044f52b1e4828721e03c76b931d';

export const PRODUCTION_BASENAMES = Object.freeze([
  'ast',
  'bin',
  'check',
  'cli',
  'codegen',
  'compile',
  'diagnostics',
  'features',
  'index',
  'int16',
  'lexer',
  'lineMap',
  'parser',
  'runtime',
  'scopes',
  'symbols',
  'tokens',
]);

export const PACKAGE_FILES = Object.freeze([
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'docs/c-subset.md',
  'docs/lc3cc-line-map.schema.json',
  'docs/line-map.md',
  'package.json',
]);

const BUILD_EXTENSIONS = Object.freeze(['d.ts', 'js', 'js.map']);
const LIFECYCLE_SCRIPTS = Object.freeze([
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
]);
const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundledDependencies',
  'bundleDependencies',
]);

export function expectedTarballPaths() {
  const buildFiles = PRODUCTION_BASENAMES.flatMap((basename) =>
    BUILD_EXTENSIONS.map((extension) => `dist/${basename}.${extension}`),
  );
  return [...PACKAGE_FILES, ...buildFiles].sort();
}

function keys(value) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null) return Object.keys(value);
  throw new Error('dependency metadata must be an object or array');
}

export function assertSafePackageManifest(manifest) {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('package.json must contain an object');
  }

  for (const field of DEPENDENCY_FIELDS) {
    const names = keys(manifest[field]);
    if (names.length > 0) {
      throw new Error(`${field} must be empty; found ${names.sort().join(', ')}`);
    }
  }

  const scripts = manifest.scripts;
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
    throw new Error('package.json scripts must contain an object');
  }
  const lifecycle = LIFECYCLE_SCRIPTS.filter((name) => Object.hasOwn(scripts, name));
  if (lifecycle.length > 0) {
    throw new Error(`package lifecycle scripts are not allowed: ${lifecycle.join(', ')}`);
  }
}

export function assertExactTarballPaths(actualPaths) {
  if (!Array.isArray(actualPaths) || !actualPaths.every((path) => typeof path === 'string')) {
    throw new Error('npm pack did not return a string file roster');
  }
  const duplicates = actualPaths.filter((path, index) => actualPaths.indexOf(path) !== index);
  if (duplicates.length > 0) {
    throw new Error(`npm pack returned duplicate paths: ${[...new Set(duplicates)].join(', ')}`);
  }
  for (const path of actualPaths) {
    if (path.startsWith('/') || path === '..' || path.startsWith('../') || path.includes('/../')) {
      throw new Error(`npm pack returned an unsafe path: ${path}`);
    }
  }

  const expected = expectedTarballPaths();
  const actual = [...actualPaths].sort();
  const missing = expected.filter((path) => !actual.includes(path));
  const unexpected = actual.filter((path) => !expected.includes(path));
  if (missing.length > 0 || unexpected.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing: ${missing.join(', ')}`);
    if (unexpected.length > 0) details.push(`unexpected: ${unexpected.join(', ')}`);
    throw new Error(`npm tarball manifest drifted — ${details.join('; ')}`);
  }
}

export function assertReviewedLicense(licenseBytes) {
  if (!(licenseBytes instanceof Uint8Array)) {
    throw new Error('LICENSE must be checked as exact bytes');
  }
  const actual = createHash('sha256').update(licenseBytes).digest('hex');
  if (actual !== REVIEWED_LICENSE_SHA256) {
    throw new Error(
      `LICENSE does not match the reviewed MIT license bytes — expected sha256 ${REVIEWED_LICENSE_SHA256}, received ${actual}`,
    );
  }
}

function moduleRequests(sourceFile) {
  const requests = [];

  function propertyName(node) {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression !== undefined &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      return node.argumentExpression.text;
    }
    return null;
  }

  function loaderPrimitiveName(node) {
    if (ts.isIdentifier(node) && (node.text === 'createRequire' || node.text === 'require')) {
      return node.text;
    }
    const name = propertyName(node);
    return name === 'createRequire' || name === 'require' ? name : null;
  }

  function addLiteral(node, context) {
    if (!ts.isStringLiteralLike(node)) {
      throw new Error(
        `${sourceFile.fileName} contains a non-literal ${context}; packed module edges must be statically reviewable`,
      );
    }
    requests.push(node.text);
  }

  function visit(node) {
    const loaderPrimitive = loaderPrimitiveName(node);
    if (loaderPrimitive !== null) {
      throw new Error(
        `${sourceFile.fileName} uses disallowed module loader primitive: ${loaderPrimitive}`,
      );
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) addLiteral(node.moduleSpecifier, 'module specifier');
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      if (node.moduleReference.expression === undefined) {
        throw new Error(`${sourceFile.fileName} contains an unresolved external module reference`);
      }
      addLiteral(node.moduleReference.expression, 'external module reference');
    } else if (ts.isImportTypeNode(node)) {
      if (!ts.isLiteralTypeNode(node.argument)) {
        throw new Error(`${sourceFile.fileName} contains a non-literal import type`);
      }
      addLiteral(node.argument.literal, 'import type');
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const commonJsRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const commonJsLoader =
        ts.isPropertyAccessExpression(node.expression) &&
        ((ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'require' &&
          node.expression.name.text === 'resolve') ||
          (ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'module' &&
            node.expression.name.text === 'require'));
      if (dynamicImport || commonJsRequire || commonJsLoader) {
        if (node.arguments.length !== 1) {
          throw new Error(
            `${sourceFile.fileName} contains a module loader call without exactly one literal request`,
          );
        }
        addLiteral(node.arguments[0], 'module loader request');
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return requests;
}

function packedRelativePath(root, importerPath, specifier) {
  const target = resolve(root, dirname(importerPath), specifier);
  const path = relative(root, target).split(sep).join('/');
  if (path === '..' || path.startsWith('../')) return null;
  return path;
}

function assertPortableSourceMapPath(mapPath, field, value, allowEmpty = false) {
  if (value === '' && allowEmpty) return;
  if (
    value === '' ||
    value !== value.trim() ||
    isAbsolute(value) ||
    value.startsWith('//') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
    value.includes('\\') ||
    /[?#]/.test(value) ||
    /%(?:2e|2f|5c)/i.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      `${mapPath} ${field} must be a portable relative source-map path: ${JSON.stringify(value)}`,
    );
  }
}

export function assertPackedModuleClosure(root, packedPaths) {
  const packed = new Set(packedPaths);
  const sourceMapPaths = packedPaths.filter(
    (path) => path.startsWith('dist/') && path.endsWith('.js.map'),
  );
  const modulePaths = packedPaths.filter(
    (path) => path.startsWith('dist/') && (path.endsWith('.js') || path.endsWith('.d.ts')),
  );

  for (const mapPath of sourceMapPaths) {
    let sourceMap;
    try {
      sourceMap = JSON.parse(readFileSync(join(root, mapPath), 'utf8'));
    } catch {
      throw new Error(`${mapPath} is not valid JSON source map data`);
    }
    if (typeof sourceMap !== 'object' || sourceMap === null || Array.isArray(sourceMap)) {
      throw new Error(`${mapPath} must contain a source map object`);
    }
    if (sourceMap.version !== 3) {
      throw new Error(`${mapPath} must use source map version 3`);
    }
    if (
      !Array.isArray(sourceMap.sources) ||
      sourceMap.sources.length === 0 ||
      !sourceMap.sources.every((source) => typeof source === 'string')
    ) {
      throw new Error(`${mapPath} must contain at least one source path string`);
    }
    if (sourceMap.sourceRoot !== undefined && typeof sourceMap.sourceRoot !== 'string') {
      throw new Error(`${mapPath} sourceRoot must be a string when present`);
    }
    assertPortableSourceMapPath(mapPath, 'sourceRoot', sourceMap.sourceRoot ?? '', true);
    for (const source of sourceMap.sources) {
      assertPortableSourceMapPath(mapPath, 'source', source);
    }

    const contents = sourceMap.sourcesContent;
    if (
      contents !== undefined &&
      (!Array.isArray(contents) ||
        contents.length !== sourceMap.sources.length ||
        !contents.every((content) => content === null || typeof content === 'string'))
    ) {
      throw new Error(`${mapPath} must pair each source with one string or null sourcesContent`);
    }

    for (let index = 0; index < sourceMap.sources.length; index += 1) {
      if (typeof contents?.[index] === 'string') continue;
      const source = sourceMap.sources[index];
      const sourceRoot = sourceMap.sourceRoot ?? '';
      const rootedSource =
        sourceRoot === '' ? source : `${sourceRoot.replace(/\/?$/, '/')}${source}`;
      const target = packedRelativePath(root, mapPath, rootedSource);
      if (target === null || !packed.has(target)) {
        throw new Error(`${mapPath} source ${source} is not embedded or packed`);
      }
    }
  }

  for (const importerPath of modulePaths) {
    const source = readFileSync(join(root, importerPath), 'utf8');
    const scriptKind = importerPath.endsWith('.d.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sourceFile = ts.createSourceFile(
      importerPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );
    const diagnostics = sourceFile.parseDiagnostics ?? [];
    if (diagnostics.length > 0) {
      throw new Error(`${importerPath} is not parseable generated output`);
    }

    for (const directive of sourceFile.typeReferenceDirectives) {
      throw new Error(`${importerPath} references an external type package: ${directive.fileName}`);
    }
    for (const reference of sourceFile.referencedFiles) {
      const target = packedRelativePath(root, importerPath, reference.fileName);
      if (target === null || !packed.has(target)) {
        throw new Error(
          `${importerPath} has a path reference outside the packed module closure: ${reference.fileName}`,
        );
      }
    }

    for (const specifier of moduleRequests(sourceFile)) {
      if (specifier === 'node:module') {
        throw new Error(`${importerPath} uses disallowed module loader primitive: node:module`);
      }
      if (specifier.startsWith('node:')) {
        if (importerPath.endsWith('.d.ts')) {
          throw new Error(`${importerPath} references an external node type module: ${specifier}`);
        }
        if (!isBuiltin(specifier)) {
          throw new Error(`${importerPath} imports an unknown node module: ${specifier}`);
        }
        continue;
      }
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        throw new Error(`${importerPath} has an external package import: ${specifier}`);
      }
      const target = packedRelativePath(root, importerPath, specifier);
      if (target === null || !packed.has(target)) {
        throw new Error(
          `${importerPath} has a relative import outside the packed module closure: ${specifier}`,
        );
      }
    }
  }
}

export function checkPackage(root = PACKAGE_ROOT) {
  const manifest = JSON.parse(
    readFileSync(new URL('package.json', pathToFileURL(`${root}/`)), 'utf8'),
  );
  assertSafePackageManifest(manifest);

  const cacheDirectory = mkdtempSync(join(tmpdir(), 'lc3cc-npm-pack-'));
  let packed;
  try {
    packed = spawnSync(
      'npm',
      [
        'pack',
        '--json',
        '--dry-run',
        '--ignore-scripts',
        '--update-notifier=false',
        '--cache',
        cacheDirectory,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } finally {
    rmSync(cacheDirectory, { force: true, recursive: true });
  }
  if (packed.error !== undefined) throw packed.error;
  if (packed.status !== 0) {
    throw new Error(`npm pack failed (${packed.status ?? 'signal'}): ${packed.stderr.trim()}`);
  }

  let report;
  try {
    report = JSON.parse(packed.stdout);
  } catch {
    throw new Error('npm pack did not return valid JSON');
  }
  if (!Array.isArray(report) || report.length !== 1 || !Array.isArray(report[0]?.files)) {
    throw new Error('npm pack returned an unexpected report shape');
  }
  const actualPaths = report[0].files.map((entry) => entry?.path);
  assertExactTarballPaths(actualPaths);
  assertReviewedLicense(readFileSync(join(root, 'LICENSE')));
  assertPackedModuleClosure(root, actualPaths);
  return { files: [...actualPaths].sort(), packageRoot: root };
}

function isDirectInvocation() {
  if (process.argv[1] === undefined) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  try {
    const result = checkPackage();
    process.stdout.write(`Package check passed — ${result.files.length} exact tarball files.\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Package check FAILED — ${message}\n`);
    process.exitCode = 1;
  }
}

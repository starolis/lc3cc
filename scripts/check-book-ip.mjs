// Scan a public source tree, or every text-bearing blob, commit message, and
// annotated-tag message reachable from its Git refs, for prose copied from a
// locally supplied book corpus. The corpus is never part of the package. This
// module uses only Node.js and an optional local `pdftotext` executable when the
// operator supplies a PDF.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SHINGLE_WORDS = 8;
export const QUOTED_MIN_WORDS = 3;
export const MIN_CORPUS_WORDS = 10_000;
export const TRUSTED_BOOK_SHA256 =
  '093bec0ba3c2af9509948c1c9447121f48fe2885b8c7bf10361cf347156a07a9';

export const BIBLIOGRAPHIC_TITLE =
  'Introduction to Computing Systems: From Bits and Gates to C/C++ and Beyond';
export const BIBLIOGRAPHIC_AUTHORS = 'Yale N. Patt and Sanjay J. Patel';
export const BIBLIOGRAPHIC_EDITION = 'Third Edition';
export const BIBLIOGRAPHIC_TITLE_VARIANTS = Object.freeze([
  BIBLIOGRAPHIC_TITLE,
  'Introduction to Computing Systems From Bits Gates to C C Beyond',
  'Introduction to Computing Systems: From Bits and Gates to C and Beyond',
]);

// Bibliographic facts identify the source rather than reproduce its prose. No
// other passage is forgiven by either the tree or history scan.
export const BIBLIOGRAPHIC_PASSAGES = Object.freeze([
  ...BIBLIOGRAPHIC_TITLE_VARIANTS,
  `Title ${BIBLIOGRAPHIC_TITLE_VARIANTS[1]}`,
  BIBLIOGRAPHIC_AUTHORS,
  BIBLIOGRAPHIC_EDITION,
  '3rd Edition',
  `${BIBLIOGRAPHIC_TITLE}, ${BIBLIOGRAPHIC_AUTHORS}, ${BIBLIOGRAPHIC_EDITION}`,
]);

const ATTRIBUTION_PATTERN =
  /\b(?:book|text|textbook|authors?|Patt|Patel|chapter|section|edition)\b|\bIntroduction\s+to\s+Computing\s+Systems\b/i;
const LC3_ASSEMBLY_TOKEN =
  /^(?:r[0-7]|[0-9]+|x[0-9a-f]+|b[01]+|add|and|br(?:n?z?p?)?|jmp|jsr|jsrr|ld|ldi|ldr|lea|not|ret|rti|st|sti|str|trap|orig|fill|blkw|stringz|end|getc|out|puts|in|putsp|halt|nop)$/;
const LINE_MARKER = /^[ \t]*(?:\/\/+|\/\*+|\*+\/|\*|#+|>+)?[ \t]*/;
const MAX_GIT_OUTPUT = 512 * 1024 * 1024;

function displayPath(root, path) {
  const shown = relative(root, path).split(sep).join('/');
  return shown === '' ? '.' : shown;
}

export function decodeUtf8(bytes, label) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`${label}: expected bytes`);
  if (bytes.includes(0)) throw new Error(`${label}: contains a NUL byte`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label}: is not valid UTF-8`);
  }
}

export function normalizeWords(text) {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function containsWordSequence(words, phrase) {
  const haystack = ` ${words.join(' ')} `;
  const needle = ` ${normalizeWords(phrase).join(' ')} `;
  return haystack.includes(needle);
}

function isProseWindow(words) {
  // Register names and numeric operands are normal technical prose. Exclude
  // only windows that are entirely an LC-3 instruction/directive token stream.
  return !words.every((word) => LC3_ASSEMBLY_TOKEN.test(word));
}

export function proseShingles(text) {
  const words = normalizeWords(text);
  const shingles = new Set();
  for (let index = 0; index + SHINGLE_WORDS <= words.length; index += 1) {
    const window = words.slice(index, index + SHINGLE_WORDS);
    if (isProseWindow(window)) shingles.add(window.join(' '));
  }
  return shingles;
}

function bibliographicShingles() {
  const allowed = new Set();
  for (const passage of BIBLIOGRAPHIC_PASSAGES) {
    for (const shingle of proseShingles(passage)) allowed.add(shingle);
  }
  return allowed;
}

function bibliographicQuotes() {
  return BIBLIOGRAPHIC_PASSAGES.map((passage) => ` ${normalizeWords(passage).join(' ')} `);
}

export function validateBookCorpus(bookText) {
  if (typeof bookText !== 'string') throw new TypeError('book corpus must be text');
  const words = normalizeWords(bookText);
  const missing = [];
  const proseWordCount = words.filter((word) => /^[a-z]+$/.test(word)).length;
  if (proseWordCount < MIN_CORPUS_WORDS) missing.push(`at least ${MIN_CORPUS_WORDS} words`);
  const carriesTitle = BIBLIOGRAPHIC_TITLE_VARIANTS.some((title) =>
    containsWordSequence(words, title),
  );
  if (!carriesTitle) {
    missing.push('the title');
  }
  if (!containsWordSequence(words, 'Yale N Patt')) missing.push('the first author');
  if (!containsWordSequence(words, 'Sanjay J Patel')) missing.push('the second author');
  if (
    !containsWordSequence(words, 'Third Edition') &&
    !containsWordSequence(words, '3rd Edition')
  ) {
    missing.push('the third-edition marker');
  }
  if (missing.length > 0) {
    throw new Error(`book corpus failed identity checks: missing ${missing.join(', ')}`);
  }
  return bookText;
}

function assertRegularCorpusFile(path) {
  let status;
  try {
    status = lstatSync(path);
  } catch (error) {
    throw new Error(`cannot inspect book corpus ${path}: ${error.message}`);
  }
  if (status.isSymbolicLink())
    throw new Error(`book corpus ${path}: symbolic links are not allowed`);
  if (!status.isFile()) throw new Error(`book corpus ${path}: is not a regular file`);
}

export function extractPdfText(bytes, label = 'book corpus') {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`${label}: expected PDF bytes`);
  try {
    const output = execFileSync('pdftotext', ['-q', '-', '-'], {
      input: bytes,
      maxBuffer: MAX_GIT_OUTPUT,
    });
    return decodeUtf8(output, `text extracted from ${label}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('pdftotext is required to read a PDF corpus');
    }
    throw error;
  }
}

export function loadBookCorpus(
  bookPaths,
  { requireBook = false, pdfReader = extractPdfText, trustedBookSha256 = TRUSTED_BOOK_SHA256 } = {},
) {
  if (!Array.isArray(bookPaths)) throw new TypeError('book paths must be an array');
  if (bookPaths.length === 0) {
    if (requireBook) throw new Error('a local book corpus is required; pass --book <path>');
    return null;
  }
  if (bookPaths.length !== 1) {
    throw new Error('exactly one trusted third-edition PDF corpus is required');
  }
  if (!/^[0-9a-f]{64}$/i.test(trustedBookSha256)) {
    throw new Error('trusted book SHA-256 must be exactly 64 hexadecimal characters');
  }

  const path = resolve(bookPaths[0]);
  assertRegularCorpusFile(path);
  if (extname(path).toLowerCase() !== '.pdf') {
    throw new Error(`book corpus ${path}: expected the trusted PDF file`);
  }
  const bytes = readFileSync(path);
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== trustedBookSha256.toLowerCase()) {
    throw new Error(
      `book corpus ${path}: SHA-256 ${actualSha256} is not the trusted third-edition corpus`,
    );
  }

  return validateBookCorpus(pdfReader(bytes, path));
}

function sortNames(left, right) {
  return Buffer.compare(left.bytes, right.bytes);
}

export function collectTreeTextFiles(root) {
  const lexicalRoot = resolve(root);
  let rootStatus;
  try {
    rootStatus = lstatSync(lexicalRoot);
  } catch (error) {
    throw new Error(`cannot inspect tree root ${lexicalRoot}: ${error.message}`);
  }
  if (rootStatus.isSymbolicLink()) throw new Error(`tree root ${lexicalRoot}: is a symbolic link`);
  if (!rootStatus.isDirectory()) throw new Error(`tree root ${lexicalRoot}: is not a directory`);

  const files = [];
  function walk(directory, relativeDirectory) {
    let entries;
    try {
      entries = readdirSync(directory, { encoding: 'buffer', withFileTypes: true })
        .map((entry) => ({
          bytes: entry.name,
          name: decodeUtf8(entry.name, `entry name below ${displayPath(lexicalRoot, directory)}`),
        }))
        .sort(sortNames);
    } catch (error) {
      throw new Error(
        `cannot read directory ${displayPath(lexicalRoot, directory)}: ${error.message}`,
      );
    }

    for (const { name } of entries) {
      // Git's administrative database is not a member of the public source
      // tree. Every other entry, including every other dotfile and dotfolder,
      // is traversed without an exclusion list.
      if (relativeDirectory === '' && name === '.git') continue;

      const absolutePath = join(directory, name);
      const relativePath = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
      let status;
      try {
        status = lstatSync(absolutePath);
      } catch (error) {
        throw new Error(`cannot inspect ${relativePath}: ${error.message}`);
      }
      if (status.isSymbolicLink())
        throw new Error(`${relativePath}: symbolic links are not allowed`);
      if (status.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (!status.isFile()) throw new Error(`${relativePath}: is not a regular file`);
      files.push({
        kind: 'tree',
        path: relativePath,
        text: decodeUtf8(readFileSync(absolutePath), relativePath),
      });
    }
  }

  walk(lexicalRoot, '');
  return files;
}

function splitNulRecords(bytes, label) {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0) throw new Error(`${label}: missing NUL terminator`);
  const records = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    records.push(bytes.subarray(start, index));
    start = index + 1;
  }
  return records.filter((record) => record.length > 0);
}

function gitOutput(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    maxBuffer: MAX_GIT_OUTPUT,
    ...options,
  });
}

function readGitObjects(root, objectIds) {
  if (objectIds.length === 0) return new Map();
  const output = gitOutput(root, ['cat-file', '--batch'], {
    input: Buffer.from(`${objectIds.join('\n')}\n`, 'ascii'),
  });
  const objects = new Map();
  let offset = 0;
  while (offset < output.length) {
    const endOfHeader = output.indexOf(0x0a, offset);
    if (endOfHeader === -1) throw new Error('git cat-file returned a truncated header');
    const header = output.toString('ascii', offset, endOfHeader);
    const [objectId, type, sizeText] = header.split(' ');
    if (type === 'missing') throw new Error(`Git object ${objectId} is missing`);
    const size = Number(sizeText);
    if (!/^[0-9a-f]+$/.test(objectId ?? '') || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`git cat-file returned an invalid header: ${header}`);
    }
    const start = endOfHeader + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 0x0a) {
      throw new Error(`git cat-file returned truncated contents for ${objectId}`);
    }
    objects.set(objectId, { type, bytes: output.subarray(start, end) });
    offset = end + 1;
  }
  if (objects.size !== objectIds.length) throw new Error('git cat-file omitted a requested object');
  return objects;
}

function reachableObjectPaths(root) {
  const listing = gitOutput(root, ['rev-list', '--objects', '--all', '-z']);
  const pathsByObject = new Map();
  let pendingObjectId = null;
  for (const rawRecord of splitNulRecords(listing, 'git object listing')) {
    const record = decodeUtf8(rawRecord, 'git object listing record');
    if (/^[0-9a-f]+$/.test(record)) {
      pendingObjectId = record;
      if (!pathsByObject.has(record)) pathsByObject.set(record, new Set());
      continue;
    }
    if (!record.startsWith('path=') || pendingObjectId === null) {
      throw new Error(`git object listing contains an invalid record: ${record}`);
    }
    const path = record.slice('path='.length);
    if (path.length === 0) throw new Error(`Git object ${pendingObjectId} has an empty path`);
    if (!pathsByObject.has(pendingObjectId)) pathsByObject.set(pendingObjectId, new Set());
    pathsByObject.get(pendingObjectId).add(path);
    pendingObjectId = null;
  }
  return pathsByObject;
}

function reachableCommitIds(root) {
  const listing = gitOutput(root, ['rev-list', '--all', '-z']);
  return splitNulRecords(listing, 'git commit listing').map((record) => {
    const objectId = record.toString('ascii');
    if (!/^[0-9a-f]+$/.test(objectId)) throw new Error('git commit listing contains an invalid id');
    return objectId;
  });
}

function objectMessage(kind, objectId, bytes) {
  const separator = bytes.indexOf(Buffer.from('\n\n'));
  const message = separator === -1 ? Buffer.alloc(0) : bytes.subarray(separator + 2);
  return decodeUtf8(message, `${kind} message ${objectId}`);
}

export function collectReachableHistoryText(root) {
  const repository = resolve(root);
  const pathsByObject = reachableObjectPaths(repository);
  const namedObjects = readGitObjects(repository, [...pathsByObject.keys()]);
  const records = [];

  for (const [objectId, paths] of pathsByObject) {
    const object = namedObjects.get(objectId);
    if (object === undefined) throw new Error(`Git object ${objectId} was not read`);
    const pathList = [...paths].sort();
    if (object.type === 'blob') {
      const displayedPaths = pathList.length === 0 ? [`blob:${objectId}`] : pathList;
      const text = decodeUtf8(
        object.bytes,
        `reachable blob ${objectId} (${displayedPaths.join(', ')})`,
      );
      for (const path of displayedPaths) records.push({ kind: 'blob', objectId, path, text });
    } else if (object.type === 'tag') {
      const text = objectMessage('annotated tag', objectId, object.bytes);
      const displayedPaths = pathList.length === 0 ? [objectId] : pathList;
      for (const path of displayedPaths) {
        records.push({ kind: 'tag', objectId, path: `tag:${path}`, text });
      }
    }
  }

  const commitIds = reachableCommitIds(repository);
  const commitObjects = readGitObjects(repository, commitIds);
  for (const objectId of commitIds) {
    const object = commitObjects.get(objectId);
    if (object === undefined || object.type !== 'commit') {
      throw new Error(`reachable commit ${objectId} is not a commit object`);
    }
    records.push({
      kind: 'commit',
      objectId,
      path: `commit:${objectId}`,
      text: objectMessage('commit', objectId, object.bytes),
    });
  }

  return records;
}

function joinedLines(text) {
  const lineStarts = [];
  let joined = '';
  for (const line of text.split('\n')) {
    if (joined.length > 0) joined += ' ';
    lineStarts.push(joined.length);
    joined += line.replace(LINE_MARKER, '').trimEnd();
  }
  return { joined, lineStarts };
}

function lineAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

export function attributedQuotes(text) {
  const lines = text.split('\n');
  const { joined, lineStarts } = joinedLines(text);
  const spans = [];
  for (const pattern of [
    /"([^"]+)"/g,
    /“([^”]+)”/g,
    /(?<![a-z0-9])'([^']+)'(?![a-z0-9])/gi,
    /‘([^’]+)’/g,
    /`([^`]+)`/g,
    /<q(?:\s[^>]*)?>(.*?)<\/q\s*>/gi,
  ]) {
    for (const match of joined.matchAll(pattern)) {
      const span = match[1];
      const words = normalizeWords(span);
      if (words.length < QUOTED_MIN_WORDS) continue;
      const startLine = lineAt(lineStarts, match.index);
      const endLine = lineAt(lineStarts, match.index + match[0].length);
      const context = lines
        .slice(Math.max(0, startLine - 2), Math.min(lines.length, endLine + 1))
        .join(' ');
      if (!ATTRIBUTION_PATTERN.test(context)) continue;
      spans.push({ line: startLine, span, words: words.join(' ') });
    }
  }
  return spans.sort((left, right) => left.line - right.line);
}

export function scanRecords({ bookText, records }) {
  const bookShingles = proseShingles(bookText);
  const allowedShingles = bibliographicShingles();
  const normalizedBook = ` ${normalizeWords(bookText).join(' ')} `;
  const allowedQuotes = bibliographicQuotes();
  const findings = [];

  for (const record of records) {
    for (const shingle of proseShingles(record.text)) {
      if (!bookShingles.has(shingle) || allowedShingles.has(shingle)) continue;
      findings.push({ kind: 'prose', path: record.path, phrase: shingle, record });
    }

    for (const quote of attributedQuotes(record.text)) {
      const needle = ` ${quote.words} `;
      if (!normalizedBook.includes(needle)) continue;
      if (allowedQuotes.some((passage) => passage.includes(needle))) continue;
      findings.push({
        kind: 'quotation',
        line: quote.line,
        path: record.path,
        phrase: quote.span,
        record,
      });
    }
  }

  return findings;
}

export function runCheck({
  root,
  bookPaths = [],
  requireBook = false,
  history = false,
  pdfReader = extractPdfText,
  trustedBookSha256 = TRUSTED_BOOK_SHA256,
}) {
  const bookText = loadBookCorpus(bookPaths, {
    pdfReader,
    requireBook,
    trustedBookSha256,
  });
  const records = history ? collectReachableHistoryText(root) : collectTreeTextFiles(root);
  if (bookText === null) return { findings: [], records, skipped: true, status: 0 };
  const findings = scanRecords({ bookText, records });
  return { findings, records, skipped: false, status: findings.length === 0 ? 0 : 1 };
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function parseArguments(argv) {
  let history = false;
  let requireBook = false;
  let root = fileURLToPath(new URL('..', import.meta.url));
  const bookPaths = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--history') {
      if (history) throw usageError('--history may only be used once');
      history = true;
      continue;
    }
    if (argument === '--require-book') {
      if (requireBook) throw usageError('--require-book may only be used once');
      requireBook = true;
      continue;
    }
    if (argument === '--book' || argument === '--root') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw usageError(`${argument} requires a path`);
      }
      if (argument === '--book') bookPaths.push(value);
      else root = value;
      index += 1;
      continue;
    }
    throw usageError(`unknown option: ${argument}`);
  }
  return { bookPaths, history, requireBook, root: resolve(root) };
}

function printResult(result, history) {
  const scope = history ? 'reachable Git records' : 'public tree files';
  if (result.skipped) {
    console.log(
      `Book/IP content comparison skipped — no local corpus was supplied; strict traversal read ${result.records.length} ${scope}.`,
    );
    return;
  }
  if (result.status === 0) {
    console.log(`Book/IP check passed — ${result.records.length} ${scope} are clean.`);
    return;
  }

  console.error(`Book/IP check FAILED — found ${result.findings.length} prohibited overlap(s):`);
  for (const match of result.findings) {
    const location = match.line === undefined ? match.path : `${match.path}:${match.line}`;
    const label = match.kind === 'prose' ? `${SHINGLE_WORDS}-word prose` : 'attributed quotation';
    console.error(`  - ${location}: ${label}: ${JSON.stringify(match.phrase)}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    const result = runCheck(options);
    printResult(result, options.history);
    return result.status;
  } catch (error) {
    const exitCode = error.exitCode === 2 ? 2 : 1;
    console.error(`Book/IP check FAILED — ${error.message}`);
    return exitCode;
  }
}

function isDirectInvocation() {
  if (process.argv[1] === undefined) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation()) process.exitCode = main();

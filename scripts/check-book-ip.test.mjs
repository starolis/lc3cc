import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BIBLIOGRAPHIC_AUTHORS,
  BIBLIOGRAPHIC_EDITION,
  BIBLIOGRAPHIC_PASSAGES,
  BIBLIOGRAPHIC_TITLE,
  BIBLIOGRAPHIC_TITLE_VARIANTS,
  MIN_CORPUS_WORDS,
  TRUSTED_BOOK_SHA256,
  collectReachableHistoryText,
  collectTreeTextFiles,
  loadBookCorpus,
  runCheck,
  scanRecords,
  validateBookCorpus,
} from './check-book-ip.mjs';

const SCRIPT = fileURLToPath(new URL('check-book-ip.mjs', import.meta.url));
const TEST_FILE = fileURLToPath(import.meta.url);

// Split every planted passage so this test file remains clean when the checker
// reads its own source. The runtime values, not these fragments, are the causal
// controls.
const LONG_LEFT = ['when', 'the', 'lantern', 'turns'].join(' ');
const LONG_RIGHT = ['we', 'can', 'follow', 'through'].join(' ');
const LONG_PROSE = `${LONG_LEFT} ${LONG_RIGHT}`;
const TECHNICAL_LEFT = ['opcode', 'register', 'vector', 'trap'].join(' ');
const TECHNICAL_RIGHT = ['memory', 'offset', 'label', 'instruction'].join(' ');
const TECHNICAL_PROSE = `${TECHNICAL_LEFT} ${TECHNICAL_RIGHT}`;
const NUMBERED_LEFT = ['the', 'lc', '3', 'register'].join(' ');
const NUMBERED_RIGHT = ['file', 'has', 'eight', 'registers'].join(' ');
const NUMBERED_PROSE = `${NUMBERED_LEFT} ${NUMBERED_RIGHT}`;
const IDENTIFIER_LEFT = ['registers', 'r0', 'r1', 'r2'].join(' ');
const IDENTIFIER_RIGHT = ['store', 'three', 'input', 'values'].join(' ');
const IDENTIFIER_PROSE = `${IDENTIFIER_LEFT} ${IDENTIFIER_RIGHT}`;
const ASSEMBLY_LEFT = ['add', 'r6', 'r6', '1'].join(' ');
const ASSEMBLY_RIGHT = ['str', 'r7', 'r6', '0'].join(' ');
const ASSEMBLY_STREAM = `${ASSEMBLY_LEFT} ${ASSEMBLY_RIGHT}`;
const SHORT_LEFT = ['the', 'quiet'].join(' ');
const SHORT_RIGHT = ['relay', 'opens'].join(' ');
const SHORT_PROSE = `${SHORT_LEFT} ${SHORT_RIGHT}`;

const BIBLIOGRAPHIC_CITATION = `${BIBLIOGRAPHIC_TITLE}, ${BIBLIOGRAPHIC_AUTHORS}, ${BIBLIOGRAPHIC_EDITION}`;
const PDF_TITLE_METADATA = [
  ['Title', 'Introduction', 'to', 'Computing', 'Systems'].join(' '),
  ['From', 'Bits', 'Gates', 'to', 'C', 'C', 'Beyond'].join(' '),
].join(' ');
const EXPECTED_TITLE_VARIANT_SHA256 = Object.freeze([
  '74e9b3fa7554d723b4e7e0d4dd80f71624127a431cb68cb4a3ec10cfff0168c7',
  '88eab671b28e1514f1abb763eb37f21b20ad8d11d73aca5e8c1502aaba704d9e',
  'db9b2b5cc2172e1700346728e0daaee9b44d9b60d149285cbb07a2b1f669ceed',
]);

function validCorpus(extra = '') {
  const neutralBulk = Array(MIN_CORPUS_WORDS).fill('neutral').join(' ');
  return [
    BIBLIOGRAPHIC_CITATION,
    neutralBulk,
    LONG_PROSE,
    TECHNICAL_PROSE,
    NUMBERED_PROSE,
    IDENTIFIER_PROSE,
    ASSEMBLY_STREAM,
    SHORT_PROSE,
    extra,
  ].join('\n');
}

function withTemporaryDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'lc3cc-public-book-ip-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeSyntheticPdf(directory, bookText = validCorpus()) {
  const path = join(directory, 'synthetic-book.pdf');
  const bytes = Buffer.from('lc3cc synthetic book-scanner fixture\n', 'utf8');
  writeFileSync(path, bytes);
  return {
    bookPaths: [path],
    pdfReader: () => bookText,
    requireBook: true,
    trustedBookSha256: sha256(bytes),
  };
}

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function initializeRepository(root) {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Public Checker Test']);
  git(root, ['config', 'user.email', 'checker@example.invalid']);
}

function commitAll(root, message) {
  git(root, ['add', '--all']);
  git(root, ['commit', '-q', '-m', message]);
}

test('a clean synthetic tree produces no content findings', () => {
  const findings = scanRecords({
    bookText: validCorpus(),
    records: [
      {
        kind: 'tree',
        path: 'README.md',
        text: 'This compiler emits assembly and a map for each successful source.',
      },
    ],
  });

  assert.deepEqual(findings, []);
});

test('an eight-word prose overlap fails the content scan', () => {
  const findings = scanRecords({
    bookText: validCorpus(),
    records: [{ kind: 'tree', path: 'guide.md', text: LONG_PROSE }],
  });

  assert.ok(findings.some((finding) => finding.kind === 'prose'));
  assert.ok(findings.every((finding) => finding.path === 'guide.md'));
});

test('an exact technical eight-word overlap fails without function words', () => {
  const findings = scanRecords({
    bookText: validCorpus(),
    records: [{ kind: 'tree', path: 'architecture.md', text: TECHNICAL_PROSE }],
  });

  assert.deepEqual(
    findings.map(({ kind, path, phrase }) => ({ kind, path, phrase })),
    [{ kind: 'prose', path: 'architecture.md', phrase: TECHNICAL_PROSE }],
  );
});

test('an exact technical eight-token overlap fails when it contains a numeral', () => {
  const findings = scanRecords({
    bookText: validCorpus(),
    records: [{ kind: 'tree', path: 'registers.md', text: NUMBERED_PROSE }],
  });

  assert.deepEqual(
    findings.map(({ kind, path, phrase }) => ({ kind, path, phrase })),
    [{ kind: 'prose', path: 'registers.md', phrase: NUMBERED_PROSE }],
  );
});

test('an exact technical eight-token overlap fails with three register identifiers', () => {
  const findings = scanRecords({
    bookText: validCorpus(),
    records: [{ kind: 'tree', path: 'register-file.md', text: IDENTIFIER_PROSE }],
  });

  assert.deepEqual(
    findings.map(({ kind, path, phrase }) => ({ kind, path, phrase })),
    [{ kind: 'prose', path: 'register-file.md', phrase: IDENTIFIER_PROSE }],
  );
});

test('an LC-3 instruction token stream is not classified as prose', () => {
  const findings = scanRecords({
    bookText: validCorpus(),
    records: [{ kind: 'tree', path: 'routine.asm', text: ASSEMBLY_STREAM }],
  });

  assert.deepEqual(findings, []);
});

test('a short attributed quotation is caught below the shingle length', () => {
  const text = `The textbook attributes "${SHORT_PROSE}" to its authors.`;
  const findings = scanRecords({
    bookText: validCorpus(),
    records: [{ kind: 'tree', path: 'notes.md', text }],
  });

  assert.equal(findings.filter((finding) => finding.kind === 'prose').length, 0);
  assert.deepEqual(
    findings.filter((finding) => finding.kind === 'quotation').map(({ phrase }) => phrase),
    [SHORT_PROSE],
  );
});

test('short attributed quotations are caught in single quotes, backticks, and q elements', () => {
  const records = [
    { kind: 'tree', path: 'single.md', text: `The textbook attributes '${SHORT_PROSE}'.` },
    { kind: 'tree', path: 'backtick.md', text: `The textbook attributes \`${SHORT_PROSE}\`.` },
    { kind: 'tree', path: 'element.html', text: `The textbook attributes <q>${SHORT_PROSE}</q>.` },
  ];
  const findings = scanRecords({ bookText: validCorpus(), records });

  assert.deepEqual(
    findings.map(({ kind, path, phrase }) => ({ kind, path, phrase })),
    [
      { kind: 'quotation', path: 'single.md', phrase: SHORT_PROSE },
      { kind: 'quotation', path: 'backtick.md', phrase: SHORT_PROSE },
      { kind: 'quotation', path: 'element.html', phrase: SHORT_PROSE },
    ],
  );
});

test('bibliographic title, authors, and edition are the only allowed source overlap', () => {
  const text = `The textbook citation is "${BIBLIOGRAPHIC_CITATION}".`;
  assert.deepEqual(
    scanRecords({
      bookText: validCorpus(),
      records: [{ kind: 'tree', path: 'citation.md', text }],
    }),
    [],
  );
});

test('the PDF metadata title is allowed without forgiving adjacent book prose', () => {
  const bookText = validCorpus(PDF_TITLE_METADATA);
  const titleRecord = {
    kind: 'tree',
    path: 'scripts/check-book-ip.mjs',
    text: `BIBLIOGRAPHIC_TITLE = '${PDF_TITLE_METADATA.slice('Title '.length)}'`,
  };

  assert.deepEqual(scanRecords({ bookText, records: [titleRecord] }), []);

  const findings = scanRecords({
    bookText,
    records: [titleRecord, { kind: 'tree', path: 'extra.md', text: LONG_PROSE }],
  });
  assert.deepEqual(
    findings.map(({ kind, path, phrase }) => ({ kind, path, phrase })),
    [{ kind: 'prose', path: 'extra.md', phrase: LONG_PROSE }],
  );
});

test('every corpus-identity title variant is a matching self-scan exception', () => {
  assert.deepEqual(
    BIBLIOGRAPHIC_TITLE_VARIANTS.map((title) => sha256(title)),
    EXPECTED_TITLE_VARIANT_SHA256,
    'the exact corpus-identity title roster requires an explicit test decision',
  );
  for (const title of BIBLIOGRAPHIC_TITLE_VARIANTS) {
    assert.ok(BIBLIOGRAPHIC_PASSAGES.includes(title));
    assert.deepEqual(
      scanRecords({
        bookText: validCorpus(title),
        records: [
          {
            kind: 'tree',
            path: 'scripts/check-book-ip.mjs',
            text: `const corpusIdentityTitle = ${JSON.stringify(title)};`,
          },
        ],
      }),
      [],
    );
  }
});

test('required, missing, and wrong local corpora fail closed', () => {
  assert.throws(() => loadBookCorpus([], { requireBook: true }), /local book corpus is required/);

  const wrongEdition = `${BIBLIOGRAPHIC_TITLE}, ${BIBLIOGRAPHIC_AUTHORS}, Second Edition`;
  const wrongCorpus = [wrongEdition, Array(MIN_CORPUS_WORDS).fill('neutral').join(' ')].join('\n');
  assert.throws(() => validateBookCorpus(wrongCorpus), /third-edition marker/);

  withTemporaryDirectory((directory) => {
    const fixture = writeSyntheticPdf(directory, wrongCorpus);
    assert.throws(
      () => loadBookCorpus([...fixture.bookPaths, ...fixture.bookPaths], fixture),
      /exactly one trusted third-edition PDF/,
    );
    assert.throws(() => loadBookCorpus(fixture.bookPaths), /not the trusted third-edition corpus/);
    assert.throws(() => loadBookCorpus(fixture.bookPaths, fixture), /third-edition marker/);

    const textCorpus = join(directory, 'book.txt');
    writeText(textCorpus, wrongCorpus);
    assert.throws(
      () =>
        loadBookCorpus([textCorpus], {
          pdfReader: () => wrongCorpus,
          trustedBookSha256: sha256(readFileSync(textCorpus)),
        }),
      /expected the trusted PDF file/,
    );
  });
});

test('a metadata-only decoy cannot stand in for the trusted book', () => {
  const metadataOnly = [
    BIBLIOGRAPHIC_CITATION,
    Array(MIN_CORPUS_WORDS).fill('neutral').join(' '),
  ].join('\n');
  assert.equal(validateBookCorpus(metadataOnly), metadataOnly);

  withTemporaryDirectory((directory) => {
    const fixture = writeSyntheticPdf(directory, metadataOnly);
    assert.throws(() => loadBookCorpus(fixture.bookPaths), /not the trusted third-edition corpus/);
  });
});

test('fingerprinting and extraction consume the same immutable PDF bytes', () => {
  withTemporaryDirectory((directory) => {
    const bookText = validCorpus();
    const fixture = writeSyntheticPdf(directory, bookText);
    const expected = readFileSync(fixture.bookPaths[0]);
    const actual = loadBookCorpus(fixture.bookPaths, {
      ...fixture,
      pdfReader(bytes, path) {
        assert.equal(path, fixture.bookPaths[0]);
        assert.deepEqual(bytes, expected);
        return bookText;
      },
    });
    assert.equal(actual, bookText);
  });
});

test('the production corpus fingerprint is an exact SHA-256', () => {
  assert.equal(
    TRUSTED_BOOK_SHA256,
    '093bec0ba3c2af9509948c1c9447121f48fe2885b8c7bf10361cf347156a07a9',
    'changing the trusted corpus requires an explicit release-policy decision',
  );
});

test('tree traversal includes ordinary dotfiles and nested hidden directories', () => {
  withTemporaryDirectory((directory) => {
    writeText(join(directory, '.env.example'), 'PUBLIC_SETTING=example\n');
    writeText(join(directory, '.hidden', 'notes.md'), LONG_PROSE);
    writeText(join(directory, 'visible.md'), 'ordinary public prose\n');

    const files = collectTreeTextFiles(directory);
    assert.deepEqual(
      files.map(({ path }) => path),
      ['.env.example', '.hidden/notes.md', 'visible.md'],
    );
    const findings = scanRecords({ bookText: validCorpus(), records: files });
    assert.ok(findings.some((finding) => finding.path === '.hidden/notes.md'));
  });
});

test('tree traversal rejects a NUL byte and invalid UTF-8 instead of skipping either file', () => {
  withTemporaryDirectory((directory) => {
    writeFileSync(join(directory, 'nul.bin'), Buffer.from([0x61, 0x00, 0x62]));
    assert.throws(() => collectTreeTextFiles(directory), /nul\.bin: contains a NUL byte/);
  });

  withTemporaryDirectory((directory) => {
    writeFileSync(join(directory, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
    assert.throws(() => collectTreeTextFiles(directory), /invalid\.txt: is not valid UTF-8/);
  });
});

test('tree traversal rejects symlinks and nonregular filesystem entries', () => {
  withTemporaryDirectory((directory) => {
    writeText(join(directory, 'target.txt'), 'target\n');
    symlinkSync('target.txt', join(directory, 'alias.txt'));
    assert.throws(
      () => collectTreeTextFiles(directory),
      /alias\.txt: symbolic links are not allowed/,
    );
  });

  withTemporaryDirectory((directory) => {
    const fifo = join(directory, 'channel');
    execFileSync('mkfifo', [fifo]);
    assert.throws(() => collectTreeTextFiles(directory), /channel: is not a regular file/);
  });
});

test('history scans a prohibited blob reachable only from another branch', () => {
  withTemporaryDirectory((directory) => {
    initializeRepository(directory);
    writeText(join(directory, 'README.md'), 'clean public source\n');
    commitAll(directory, 'initial source');

    git(directory, ['switch', '-q', '-c', 'archive']);
    const pathDirectory = ['pri', 'vate'].join('');
    const historicalPath = join(directory, pathDirectory, 'archived notes.md');
    writeText(historicalPath, LONG_PROSE);
    commitAll(directory, 'branch-only prose');
    git(directory, ['switch', '-q', 'main']);

    assert.deepEqual(
      scanRecords({ bookText: validCorpus(), records: collectTreeTextFiles(directory) }),
      [],
    );
    const findings = scanRecords({
      bookText: validCorpus(),
      records: collectReachableHistoryText(directory),
    });
    assert.ok(
      findings.some(
        (finding) => finding.kind === 'prose' && finding.path.endsWith('/archived notes.md'),
      ),
    );
  });
});

test('history rejects a NUL-bearing reachable blob instead of treating it as nontext', () => {
  withTemporaryDirectory((directory) => {
    initializeRepository(directory);
    writeText(join(directory, 'README.md'), 'clean public source\n');
    writeFileSync(join(directory, 'archive.bin'), Buffer.from([0x61, 0x00, 0x62]));
    commitAll(directory, 'binary control');
    unlinkSync(join(directory, 'archive.bin'));
    commitAll(directory, 'remove binary control');

    assert.throws(
      () => collectReachableHistoryText(directory),
      /reachable blob .*archive\.bin.*contains a NUL byte/,
    );
  });
});

test('history scans every reachable commit message as content', () => {
  withTemporaryDirectory((directory) => {
    initializeRepository(directory);
    writeText(join(directory, 'README.md'), 'clean public source\n');
    commitAll(directory, LONG_PROSE);

    assert.deepEqual(
      scanRecords({ bookText: validCorpus(), records: collectTreeTextFiles(directory) }),
      [],
    );
    const findings = scanRecords({
      bookText: validCorpus(),
      records: collectReachableHistoryText(directory),
    });
    assert.ok(
      findings.some((finding) => finding.kind === 'prose' && finding.record.kind === 'commit'),
    );
  });
});

test('history scans every reachable annotated-tag message as content', () => {
  withTemporaryDirectory((directory) => {
    initializeRepository(directory);
    writeText(join(directory, 'README.md'), 'clean public source\n');
    commitAll(directory, 'initial source');
    git(directory, ['tag', '-a', 'v1.0.0', '-m', LONG_PROSE]);

    assert.deepEqual(
      scanRecords({ bookText: validCorpus(), records: collectTreeTextFiles(directory) }),
      [],
    );
    const findings = scanRecords({
      bookText: validCorpus(),
      records: collectReachableHistoryText(directory),
    });
    assert.ok(
      findings.some((finding) => finding.kind === 'prose' && finding.record.kind === 'tag'),
    );
  });
});

test('history scans a prohibited pathless blob targeted directly by an annotated tag', () => {
  withTemporaryDirectory((directory) => {
    initializeRepository(directory);
    writeText(join(directory, 'README.md'), 'clean public source\n');
    commitAll(directory, 'initial source');
    const objectId = git(directory, ['hash-object', '-w', '--stdin'], {
      input: TECHNICAL_PROSE,
    }).trim();
    git(directory, ['tag', '-a', 'prohibited-blob', objectId, '-m', 'archived data']);

    assert.deepEqual(
      scanRecords({ bookText: validCorpus(), records: collectTreeTextFiles(directory) }),
      [],
    );
    const records = collectReachableHistoryText(directory);
    assert.ok(
      records.some(
        (record) =>
          record.kind === 'blob' &&
          record.objectId === objectId &&
          record.path === `blob:${objectId}`,
      ),
    );
    const findings = scanRecords({ bookText: validCorpus(), records });
    assert.ok(
      findings.some(
        (finding) =>
          finding.kind === 'prose' &&
          finding.record.kind === 'blob' &&
          finding.record.objectId === objectId,
      ),
    );
  });
});

test('the checker and its causal tests scan clean against their invented corpus', () => {
  const records = [SCRIPT, TEST_FILE].map((path) => ({
    kind: 'tree',
    path: path === SCRIPT ? 'scripts/check-book-ip.mjs' : 'scripts/check-book-ip.test.mjs',
    text: readFileSync(path, 'utf8'),
  }));

  assert.deepEqual(scanRecords({ bookText: validCorpus(), records }), []);
});

test('the injected scanner route reports clean and planted trees through its status', () => {
  withTemporaryDirectory((directory) => {
    const tree = join(directory, 'tree');
    writeText(join(tree, 'README.md'), 'clean public source\n');
    const fixture = writeSyntheticPdf(directory);

    const clean = runCheck({ root: tree, ...fixture });
    assert.equal(clean.status, 0);
    assert.equal(clean.skipped, false);

    writeText(join(tree, '.planted.md'), LONG_PROSE);
    const planted = runCheck({ root: tree, ...fixture });
    assert.equal(planted.status, 1);
    assert.ok(planted.findings.some(({ path }) => path === '.planted.md'));
  });
});

test('the real command rejects an untrusted metadata-complete corpus', () => {
  withTemporaryDirectory((directory) => {
    const tree = join(directory, 'tree');
    writeText(join(tree, 'README.md'), 'clean public source\n');
    const fixture = writeSyntheticPdf(directory);

    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--root', tree, '--book', fixture.bookPaths[0], '--require-book'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not the trusted third-edition corpus/);
  });
});

test('the injected history route propagates a commit-message finding', () => {
  withTemporaryDirectory((directory) => {
    const repository = join(directory, 'repository');
    mkdirSync(repository);
    initializeRepository(repository);
    writeText(join(repository, 'README.md'), 'clean public source\n');
    commitAll(repository, LONG_PROSE);
    const fixture = writeSyntheticPdf(directory);

    const result = runCheck({ history: true, root: repository, ...fixture });
    assert.equal(result.status, 1);
    assert.ok(result.findings.some(({ record }) => record.kind === 'commit'));
  });
});

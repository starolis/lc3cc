#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { compileC } from './index.js';

import {
  assertDistinctPaths,
  readFileIfExists,
  removeFileIfExists,
  runCli,
  streamWriter,
  writeFileAtomically,
} from './cli.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

process.exitCode = await runCli(process.argv.slice(2), {
  assertDistinctPaths,
  compileC,
  readFileIfExists,
  readSourceBytes: readFile,
  removeFileIfExists,
  writeFileAtomically,
  stderr: streamWriter(process.stderr),
  stdout: streamWriter(process.stdout),
  version: manifest.version,
});

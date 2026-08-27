import { describe, expect, test } from 'vitest';

import * as publicApi from '../src/index.js';
import type {
  CcDiagnostic,
  CcResult,
  CLineMapEntry,
  CType,
  Program,
  RuntimeFrameInfo,
  SymbolTables,
  Token,
} from '../src/index.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

const COMPILE_RESULT_IS_EXACT: Equal<ReturnType<typeof publicApi.compileC>, CcResult> = true;
const LINE_MAP_ENTRY_IS_EXACT: Equal<CcResult['lineMap'][number], CLineMapEntry> = true;

function acceptsDocumentedTypes(values: {
  diagnostic: CcDiagnostic;
  program: Program;
  runtimeFrame: RuntimeFrameInfo;
  symbols: SymbolTables;
  token: Token;
  type: CType;
}): typeof values {
  return values;
}

const EXPECTED_RUNTIME_EXPORTS = [
  'HEAP_HEADER_WORDS',
  'KEYWORDS',
  'PUNCTUATORS',
  'REJECTED_KEYWORDS',
  'RTHP_BASE',
  'RTHP_CEIL',
  'RTHP_HEAD',
  'RTHP_INIT',
  'SUPPORTED_KEYWORDS',
  'arr',
  'check',
  'codegen',
  'compileC',
  'decay',
  'isArray',
  'isPointer',
  'isScalar',
  'isStruct',
  'lex',
  'localWordCount',
  'parse',
  'pointeeOf',
  'ptr',
  'runtimeFrames',
  'sizeInWords',
  'typeName',
  'typesEqual',
] as const;

describe('public module surface', () => {
  test('exports the exact v1 runtime names', () => {
    expect(Object.keys(publicApi).sort()).toEqual([...EXPECTED_RUNTIME_EXPORTS].sort());
  });

  test('keeps the documented result and representative public types composable', () => {
    const result = publicApi.compileC('int main(void) { return 0; }\n');

    expect(COMPILE_RESULT_IS_EXACT).toBe(true);
    expect(LINE_MAP_ENTRY_IS_EXACT).toBe(true);
    expect(
      acceptsDocumentedTypes({
        diagnostic: { line: 1, col: 1, message: 'example', severity: 'warning' },
        program: result.program!,
        runtimeFrame: publicApi.runtimeFrames().values().next().value!,
        symbols: result.symbols,
        token: publicApi.lex('0').tokens[0]!,
        type: publicApi.ptr('int'),
      }),
    ).toBeDefined();
  });
});

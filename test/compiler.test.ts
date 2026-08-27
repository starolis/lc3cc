import { describe, expect, test } from 'vitest';

import { check, codegen, compileC, lex, parse } from '../src/index.js';

describe('compileC', () => {
  test('keeps the exported stages equivalent to the complete pipeline', () => {
    const source = 'int main(void) { return 0; }\n';
    const lexed = lex(source);
    const parsed = parse(lexed.tokens);
    const checked = check(parsed.program);
    const generated = codegen(parsed.program, checked.symbols, source);
    const complete = compileC(source);

    expect(lexed.diagnostics).toEqual([]);
    expect(parsed.diagnostics).toEqual([]);
    expect(checked.diagnostics).toEqual([]);
    expect(generated.diagnostics).toEqual([]);
    expect(complete.ok).toBe(true);
    expect(complete.artifact).toBe('program');
    expect(generated.asm).toBe(complete.asm);
    expect(generated.lineMap).toEqual(complete.lineMap);
    expect([...checked.symbols.functions.keys()]).toEqual([...complete.symbols.functions.keys()]);
    expect(parsed.program.decls.length).toBe(complete.program?.decls.length);
  });

  test.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['bare CR', '\r'],
  ])('keeps the exported stages equivalent for %s source', (_name, separator) => {
    const source = ['int main(void) {', '  int value = 1;', '  return value;', '}'].join(separator);
    const lexed = lex(source);
    const parsed = parse(lexed.tokens);
    const checked = check(parsed.program);
    const generated = codegen(parsed.program, checked.symbols, source);
    const complete = compileC(source);

    expect(lexed.diagnostics).toEqual([]);
    expect(parsed.diagnostics).toEqual([]);
    expect(checked.diagnostics).toEqual([]);
    expect(generated.diagnostics).toEqual([]);
    expect(generated.asm).toBe(complete.asm);
    expect(generated.lineMap).toEqual(complete.lineMap);
    expect(generated.asm).not.toContain('\r');
  });

  test('returns a complete program only when main is defined', () => {
    const result = compileC('int main(void) { return 0; }\n');

    expect(result.ok).toBe(true);
    expect(result.artifact).toBe('program');
    expect(result.diagnostics).toEqual([]);
    expect(result.asm.startsWith('.ORIG x3000\n')).toBe(true);
    expect(result.asm.endsWith('\n.END')).toBe(true);
    expect(result.lineMap.length).toBeGreaterThan(0);
    expect(result.program).not.toBeNull();
    expect(result.symbols.functions.has('main')).toBe(true);
  });

  test('labels a successful translation without main as a non-runnable fragment', () => {
    const result = compileC('int helper(int value) { return value + 1; }\n');

    expect(result.ok).toBe(true);
    expect(result.artifact).toBe('fragment');
    expect(result.diagnostics).toEqual([
      {
        line: 1,
        col: 1,
        message: 'no main function — the program will compile but cannot run',
        severity: 'warning',
      },
    ]);
    expect(result.asm.startsWith('F_helper\n')).toBe(true);
    expect(result.asm).not.toContain('.ORIG');
    expect(result.asm).not.toContain('.END');
    expect(result.lineMap.length).toBeGreaterThan(0);
    expect(result.program).not.toBeNull();
  });

  test('never returns partial assembly when compilation fails', () => {
    const result = compileC('int main(void) { return missing; }\n');

    expect(result.ok).toBe(false);
    expect(result.artifact).toBe('none');
    expect(result.asm).toBe('');
    expect(result.lineMap).toEqual([]);
    expect(result.program).toBeNull();
    expect(result.diagnostics.some(({ severity }) => severity === 'error')).toBe(true);
  });

  test('accepts a representative array and loop program', () => {
    const result = compileC(`
int main(void) {
  int values[3];
  int index;
  int total;
  values[0] = 2;
  values[1] = 3;
  values[2] = 5;
  total = 0;
  for (index = 0; index < 3; index = index + 1) {
    total = total + values[index];
  }
  return total;
}
`);

    expect(result.ok).toBe(true);
    expect(result.artifact).toBe('program');
    expect(result.diagnostics).toEqual([]);
    expect(result.symbols.functions.has('main')).toBe(true);
    expect(result.asm).toContain('F_main');
  });

  test('rejects a named feature outside the documented subset', () => {
    const result = compileC('float value; int main(void) { return 0; }\n');

    expect(result.ok).toBe(false);
    expect(result.artifact).toBe('none');
    expect(result.asm).toBe('');
    expect(result.lineMap).toEqual([]);
    expect(result.diagnostics.map(({ severity }) => severity)).toContain('error');
    expect(result.diagnostics.map(({ message }) => message).join('\n')).toContain(
      "'float' is not part of the C subset this compiler covers",
    );
  });

  test.each([
    ['direct arithmetic', 'malloc(sizeof(struct Node) * 2) + 1'],
    [
      'a cast wrapped around invalid arithmetic',
      '(struct Node *)(malloc(sizeof(struct Node) * 2) + 1)',
    ],
  ])('rejects internal void-pointer %s', (_name, expression) => {
    const result = compileC(`
struct Node { int left; int middle; int right; };
int main(void) {
  ${expression};
  return 0;
}
`);

    expect(result.ok).toBe(false);
    expect(result.asm).toBe('');
    expect(
      result.diagnostics
        .filter(({ severity }) => severity === 'error')
        .map(({ message }) => message),
    ).toEqual([
      "pointer arithmetic cannot use malloc's internal 'void *' result because it has no object size — cast the direct malloc result to the intended object-pointer type before doing arithmetic. see the C subset page for what is supported.",
    ]);
  });

  test('keeps complete-struct scaling when malloc is cast before arithmetic', () => {
    const result = compileC(`
struct Node { int left; int middle; int right; };
int main(void) {
  struct Node *nodes = (struct Node *) malloc(sizeof(struct Node) * 2);
  nodes = nodes + 1;
  return nodes != NULL;
}
`);

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });
});

import { expect, test } from 'bun:test';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

async function lint(filePath: string, code: string) {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(code, { filePath });
  if (!result) throw new Error(`eslint returned no result for ${filePath}`);
  return result;
}

const button = 'export function Demo() { return <button type="button">Go</button>; }\n';

test('a raw button fails outside the design system', async () => {
  const result = await lint('apps/web/src/components/example.tsx', button);
  expect(result.errorCount).toBe(1);
  expect(result.messages.map((message) => message.ruleId)).toEqual(['react/forbid-elements']);
  expect(result.messages.map((message) => message.message)).toEqual([
    '<button> is forbidden, use TextInput, Button, or NNSelect.',
  ]);
});

test('raw input and select fail with the same rule', async () => {
  const result = await lint(
    'apps/web/src/components/example.tsx',
    'export function Demo() { return <form><input name="q" /><select><option>a</option></select></form>; }\n',
  );
  expect(result.errorCount).toBe(2);
  expect(result.messages.map((message) => message.message)).toEqual([
    '<input> is forbidden, use TextInput, Button, or NNSelect.',
    '<select> is forbidden, use TextInput, Button, or NNSelect.',
  ]);
});

test('design-system primitives, ui.tsx, and NNSelect may wrap natives', async () => {
  const paths = [
    'apps/web/src/components/design-system/primitives.tsx',
    'apps/web/src/components/ui.tsx',
    'apps/web/src/components/nn-select.tsx',
  ];
  const counts = await Promise.all(paths.map(async (filePath) => (await lint(filePath, button)).errorCount));
  expect(counts).toEqual([0, 0, 0]);
});

test('a component test may render a native button', async () => {
  const result = await lint('apps/web/src/components/example.test.tsx', button);
  expect(result.errorCount).toBe(0);
});

test('a comment or string that mentions a button stays legal', async () => {
  const result = await lint(
    'apps/web/src/components/example.tsx',
    'export function Demo() {\n  const label = "<button>";\n  // <input>\n  return <div />;\n}\n',
  );
  expect(result.errorCount).toBe(0);
  expect(result.messages).toEqual([]);
});

test('a file-level eslint-disable suppresses the rule until the file is migrated', async () => {
  const result = await lint(
    'apps/web/src/components/example.tsx',
    '/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */\n' +
      button,
  );
  expect(result.errorCount).toBe(0);
  expect(result.messages).toEqual([]);
});

test('textarea and a Button component stay legal', async () => {
  const result = await lint(
    'apps/web/src/components/example.tsx',
    'export function Demo() { return <div><textarea /><Button>Go</Button></div>; }\n',
  );
  expect(result.errorCount).toBe(0);
  expect(result.messages).toEqual([]);
});

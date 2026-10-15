import react from 'eslint-plugin-react';
import { parseForESLint } from './eslint/tsx-parser.mjs';

const NATIVE_CONTROLS = ['button', 'input', 'select'];

// These files are the controls. Everywhere else in apps/web must use them.
const WEB_TSX = ['apps/web/**/*.tsx', 'apps/web/**/*.jsx'];

const PRIMITIVE_FILES = [
  'apps/web/src/components/design-system/**/*.tsx',
  'apps/web/src/components/design-system/**/*.jsx',
  'apps/web/src/components/ui.tsx',
  'apps/web/src/components/nn-select.tsx',
  'apps/web/**/*.test.tsx',
  'apps/web/**/*.test.jsx',
  'apps/web/**/*.spec.tsx',
  'apps/web/**/*.spec.jsx',
];

export default [
  {
    ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', 'apps/web/public/**'],
  },
  {
    files: WEB_TSX,
    languageOptions: {
      parser: { parseForESLint },
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: { react },
    settings: { react: { version: '19.3' } },
    rules: {
      'react/forbid-elements': ['error', {
        forbid: NATIVE_CONTROLS.map((element) => ({
          element,
          message: 'use TextInput, Button, or NNSelect.',
        })),
      }],
    },
  },
  {
    files: PRIMITIVE_FILES,
    rules: { 'react/forbid-elements': 'off' },
  },
];

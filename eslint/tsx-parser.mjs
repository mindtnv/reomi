import { parse } from '@babel/parser';

// typescript-eslint refuses the repo's TypeScript 7. Babel finds the JSX tags.
// ESLint then sees only those tags. A full Babel tree makes scope analysis
// walk every StringLiteral and takes minutes on this app.
const FORBIDDEN = new Set(['button', 'input', 'select']);

export function parseForESLint(code) {
  let file;
  try {
    file = parse(code, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: false,
    });
  } catch (error) {
    const loc = error && typeof error === 'object' && 'loc' in error ? error.loc : undefined;
    const line = loc && typeof loc === 'object' && 'line' in loc ? loc.line : 1;
    const column = loc && typeof loc === 'object' && 'column' in loc ? loc.column : 0;
    const failure = new Error(error instanceof Error ? error.message : 'TSX parse failed');
    failure.lineNumber = line;
    failure.column = column + 1;
    throw failure;
  }

  const body = [];
  walk(file.program, (node) => {
    if (node.type !== 'JSXOpeningElement') return;
    const name = node.name;
    if (!name || name.type !== 'JSXIdentifier' || !FORBIDDEN.has(name.name)) return;
    body.push(expression(node, name));
  });

  const end = endLocation(code);
  return {
    ast: {
      type: 'Program',
      sourceType: 'module',
      body,
      tokens: [],
      comments: eslintComments(file.comments),
      range: [0, code.length],
      loc: { start: { line: 1, column: 0 }, end },
    },
  };
}

// Only this rule's directives are forwarded. Other files disable rules this
// config does not load, and ESLint treats those as errors.
function eslintComments(comments) {
  if (!Array.isArray(comments)) return [];
  return comments
    .filter((comment) => typeof comment.value === 'string' && comment.value.includes('react/forbid-elements'))
    .map((comment) => ({
      type: comment.type === 'CommentLine' ? 'Line' : 'Block',
      value: comment.value,
      range: [comment.start, comment.end],
      loc: comment.loc,
    }));
}

function expression(opening, name) {
  const loc = name.loc ?? opening.loc;
  const range = [name.start, name.end];
  return {
    type: 'ExpressionStatement',
    range,
    loc,
    expression: {
      type: 'JSXElement',
      range,
      loc,
      children: [],
      closingElement: null,
      openingElement: {
        type: 'JSXOpeningElement',
        range,
        loc,
        attributes: [],
        selfClosing: Boolean(opening.selfClosing),
        name: {
          type: 'JSXIdentifier',
          name: name.name,
          range,
          loc,
        },
      },
    },
  };
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
      continue;
    }
    if (value && typeof value === 'object' && typeof value.type === 'string') walk(value, visit);
  }
}

function endLocation(code) {
  let line = 1;
  let column = 0;
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === '\n') {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

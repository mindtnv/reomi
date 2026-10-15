// Idempotent rename of raw <button> and <input> to design-system primitives.
// Selects stay for a separate pass. Re-running a migrated file is a no-op.
import { parse } from '@babel/parser';
import fs from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node apps/web/scripts/migrate-native-controls.mjs <file.tsx>...');
  process.exit(1);
}

const IMPORT_SOURCE = /design-system\/primitives/;

function locIndex(code, loc) {
  let line = 1;
  let column = 0;
  for (let i = 0; i < code.length; i += 1) {
    if (line === loc.line && column === loc.column) return i;
    if (code[i] === '\n') {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  if (line === loc.line && column === loc.column) return code.length;
  throw new Error(`missing location ${loc.line}:${loc.column}`);
}

function collect(ast, code) {
  const edits = [];
  const used = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXOpeningElement' && node.name?.type === 'JSXIdentifier') {
      const tag = node.name.name;
      if (tag === 'button' || tag === 'input') {
        used.add(tag === 'button' ? 'Button' : 'TextInput');
        const start = locIndex(code, node.name.loc.start);
        const end = locIndex(code, node.name.loc.end);
        edits.push({ start, end, text: tag === 'button' ? 'Button' : 'TextInput' });
        if (tag === 'button') {
          const hasVariant = node.attributes.some((attr) => attr.type === 'JSXAttribute' && attr.name?.name === 'variant');
          if (!hasVariant) edits.push({ start: end, end, text: ' variant="bare"' });
        }
      }
    }
    if (node.type === 'JSXClosingElement' && node.name?.type === 'JSXIdentifier') {
      const tag = node.name.name;
      if (tag === 'button' || tag === 'input') {
        const start = locIndex(code, node.name.loc.start);
        const end = locIndex(code, node.name.loc.end);
        edits.push({ start, end, text: tag === 'button' ? 'Button' : 'TextInput' });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object' && value.type) walk(value);
    }
  };
  walk(ast);
  return { edits, used };
}

function ensureImport(code, names) {
  if (!names.size) return code;
  const needed = [...names];
  const importRe = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]*design-system\/primitives)['"];?/;
  const match = code.match(importRe);
  if (match && IMPORT_SOURCE.test(match[2])) {
    const current = match[1].split(',').map((part) => part.trim()).filter(Boolean);
    const missing = needed.filter((name) => !current.some((part) => part === name || part.startsWith(`${name} `)));
    if (!missing.length) return code;
    const next = [...current, ...missing].join(', ');
    return code.replace(importRe, `import { ${next} } from '${match[2]}';`);
  }
  const line = `import { ${needed.join(', ')} } from '@/components/design-system/primitives';\n`;
  const useClient = code.match(/^(['"]use client['"];?\n)/);
  if (useClient) return code.replace(useClient[1], `${useClient[1]}\n${line}`);
  return line + code;
}

for (const file of files) {
  const code = fs.readFileSync(file, 'utf8');
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const { edits, used } = collect(ast, code);
  if (!edits.length) {
    console.log(`skip ${file}`);
    continue;
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let next = code;
  for (const edit of edits) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  next = ensureImport(next, used);
  fs.writeFileSync(file, next);
  console.log(`migrated ${file} (${edits.length} edits, ${[...used].join('+')})`);
}

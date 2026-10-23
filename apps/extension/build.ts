import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = dirname(fileURLToPath(import.meta.url)), dev = process.argv.includes('--dev');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Extension version must be three numeric components');
const api = dev ? 'http://localhost:3000' : 'https://api.reomi.ru', web = dev ? 'http://localhost:3001' : 'https://app.reomi.ru';
for (const target of ['chromium', 'firefox'] as const) {
  const out = join(root, 'dist', `${target}${dev ? '-dev' : ''}`); await mkdir(out, { recursive: true });
  for (const entry of ['popup', 'background', 'capture']) {
    const result = await Bun.build({ entrypoints: [join(root, 'src', `${entry}.ts`)], outdir: out, naming: `${entry}.js`, target: 'browser', format: 'iife', minify: !dev,
      define: { __REOMI_API__: JSON.stringify(api), __REOMI_WEB__: JSON.stringify(web) } });
    if (!result.success) throw new AggregateError(result.logs, `Could not build ${entry}`);
  }
  for (const name of ['popup.html','popup.css']) await copyFile(join(root,'src',name),join(out,name));
  await copyFile(join(root,'../web/public/icons/icon-192.png'),join(out,'icon.png'));
  await copyFile(join(root,'../web/public/icons/reomi-mark.png'),join(out,'brand-mark.png'));
  const manifest = {
    manifest_version: 3, name: 'Reomi — save and study', version, description: 'Save readable pages to your Reomi library and create reviewed cards with their sources.',
    permissions: ['activeTab', 'scripting', 'storage', 'contextMenus'], host_permissions: [`${api}/*`, ...(dev && process.env.REOMI_EXTENSION_TEST_ORIGIN ? [`${new URL(process.env.REOMI_EXTENSION_TEST_ORIGIN).origin}/*`] : [])],
    action: { default_popup: 'popup.html', default_icon: 'icon.png', default_title: 'Reomi' }, icons: { '192': 'icon.png' },
    background: target === 'chromium' ? { service_worker: 'background.js' } : { scripts: ['background.js'] },
    commands: { 'capture-selection': { suggested_key: { default: 'Alt+Shift+S' }, description: 'Save a selected passage to Reomi' } },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'" },
    ...(target === 'firefox' ? { browser_specific_settings: { gecko: { id: 'capture@reomi.ru', strict_min_version: '142.0', data_collection_permissions: { required: ['websiteContent'], optional: [] } } } } : {}),
  };
  await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const entries: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const name of ['background.js','brand-mark.png','capture.js','icon.png','manifest.json','popup.css','popup.html','popup.js']) entries[name] = [new Uint8Array(await readFile(join(out,name))), { mtime: new Date('1980-01-01T00:00:00Z') }];
  const zip = join(root,'dist',`reomi-${target}${dev ? '-dev' : ''}-${version}.zip`); await writeFile(zip,zipSync(entries,{level:9}));
  process.stdout.write(`${target}: ${zip}\n`);
}

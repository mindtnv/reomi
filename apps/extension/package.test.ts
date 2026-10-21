import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';

test('production archives are reproducible, self-contained and grant only the capture permissions', async () => {
  const build = async () => { const process = Bun.spawn(['bun', 'build.ts'], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe', env: { ...Bun.env, REOMI_EXTENSION_TEST_ORIGIN: 'https://must-not-be-in-release.test' } }); expect(await process.exited).toBe(0); };
  await build();
  const { version } = await Bun.file(join(import.meta.dir, 'package.json')).json();
  const originals: Record<string, Uint8Array> = {};
  for (const target of ['chromium', 'firefox']) {
    const bytes = new Uint8Array(await Bun.file(join(import.meta.dir, `dist/reomi-${target}-${version}.zip`)).arrayBuffer()); originals[target] = bytes;
    const files = unzipSync(bytes), manifest = JSON.parse(strFromU8(files['manifest.json']!));
    expect(manifest.host_permissions).toEqual(['https://api.reomi.ru/*']);
    expect([...manifest.permissions].sort()).toEqual(['activeTab','contextMenus','scripting','storage']);
    expect(manifest.content_scripts).toBeUndefined(); expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.content_security_policy.extension_pages).not.toContain('unsafe-eval');
    for (const file of ['popup.html','popup.js','popup.css','capture.js','background.js','icon.png','brand-mark.png']) expect(files[file]!.length).toBeGreaterThan(0);
    const js = strFromU8(files['popup.js']!); expect(js).toContain('https://api.reomi.ru'); expect(js).not.toContain('localhost:3000');
    expect(manifest.version).toBe(version);
  }
  await build();
  for (const target of ['chromium','firefox']) expect(new Uint8Array(await Bun.file(join(import.meta.dir, `dist/reomi-${target}-${version}.zip`)).arrayBuffer())).toEqual(originals[target]!);
});

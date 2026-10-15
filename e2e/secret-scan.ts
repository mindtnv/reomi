import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

const mediaExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico']);
const archiveExtensions = new Set(['.zip', '.har', '.webm', '.mp4']);

export type SecretHit = { path: string; reason: 'password' | 'cookie' | 'archive' };

export function rememberSecret(secret: string) {
  const file = process.env.E2E_SECRET_FILE;
  if (!file || secret.trim() === '') return;
  appendFileSync(file, `${secret}\n`, { mode: 0o600 });
}

export function findSecretHits(roots: string[], secrets: string[]): SecretHit[] {
  const needles = secrets.map((secret) => secret.trim()).filter((secret) => secret !== '');
  if (needles.length === 0) throw new Error('refusing to scan with an empty secret');
  const hits: SecretHit[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    walk(root, needles, hits);
  }
  return hits;
}

function walk(dir: string, secrets: string[], hits: SecretHit[]) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      walk(path, secrets, hits);
      continue;
    }
    const extension = extname(name).toLowerCase();
    if (basename(name) === 'trace.zip' || archiveExtensions.has(extension)) {
      hits.push({ path, reason: 'archive' });
      continue;
    }
    if (mediaExtensions.has(extension)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (secrets.some((secret) => text.includes(secret))) {
      hits.push({ path, reason: 'password' });
      continue;
    }
    if (hasLiveSessionCookie(text)) hits.push({ path, reason: 'cookie' });
  }
}

function hasLiveSessionCookie(text: string) {
  return text.replace(/session_token(?:=|%3D)\[redacted\]/gi, '').includes('session_token');
}

export function redactSecrets(roots: string[], secrets: string[]) {
  const needles = secrets.map((secret) => secret.trim()).filter((secret) => secret !== '');
  for (const root of roots) {
    if (!existsSync(root)) continue;
    redactDir(root, needles);
  }
}

function redactDir(dir: string, secrets: string[]) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      redactDir(path, secrets);
      continue;
    }
    const extension = extname(name).toLowerCase();
    if (basename(name) === 'trace.zip' || archiveExtensions.has(extension)) {
      unlinkSync(path);
      continue;
    }
    if (mediaExtensions.has(extension)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    let next = text;
    for (const secret of secrets) next = next.split(secret).join('[redacted]');
    next = next.replace(/session_token(?:=|%3D)[^\s&;"']+/gi, 'session_token=[redacted]');
    if (next !== text) writeFileSync(path, next);
  }
}


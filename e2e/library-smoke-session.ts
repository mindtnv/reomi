import { expect, type Page } from '@playwright/test';
import { smokeTarget, type SmokeTarget } from './smoke-target';
import { rememberSecret } from './secret-scan';

// The serial library journeys share one learner, keeping the complete smoke
// within the normal five-signups-per-hour limit without weakening that limit.
let learner: SmokeTarget | undefined;
let registered = false;
export async function librarySmokeSession(page: Page) {
  const target = learner ??= smokeTarget(process.env);
  rememberSecret(target.password);
  const api = target.mode === 'prod' ? 'https://api.reomi.ru' : 'http://localhost:3000';
  const origin = target.mode === 'prod' ? 'https://app.reomi.ru' : 'http://localhost:3001';
  const create = target.mode === 'local' && !registered;
  const response = await page.request.post(`${api}/api/auth/${create ? 'sign-up' : 'sign-in'}/email`, {
    data: { email: target.email, password: target.password, ...(create ? { name: target.name } : {}) }, headers: { origin },
  });
  expect(response.ok()).toBe(true);
  if (create) registered = true;
  return { target, api, origin };
}

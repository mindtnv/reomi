export type SmokeTarget = {
  mode: 'local' | 'prod';
  email: string;
  password: string;
  name: string;
  deckName: string;
  question: string;
  answer: string;
};

export function smokeTarget(
  env: Record<string, string | undefined>,
  now = Date.now(),
  entropy = Math.random().toString(36).slice(2, 8),
): SmokeTarget {
  const prefix = `e2e-${now.toString(36)}-${entropy}`;
  const question = `${prefix} question`;
  const answer = `${prefix} answer`;
  if (env.E2E_TARGET === 'prod') {
    const email = env.E2E_EMAIL?.trim() ?? '';
    const password = env.E2E_PASSWORD ?? '';
    if (!email || password.trim() === '') {
      throw new Error('prod smoke requires E2E_EMAIL and E2E_PASSWORD');
    }
    return {
      mode: 'prod',
      email,
      password,
      name: email,
      deckName: prefix,
      question,
      answer,
    };
  }
  return {
    mode: 'local',
    email: `${prefix}@example.com`,
    password: `${prefix}-password`,
    name: prefix,
    deckName: prefix,
    question,
    answer,
  };
}

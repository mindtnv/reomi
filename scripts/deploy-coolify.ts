/** Coolify control-plane orchestration; never reads application environment values. */
export interface RolloutTransport {
  request(method: string, path: string, body?: Record<string, unknown>): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}
type Config = { api: string; web: string; sha: string; run: string; prepareOnly?: boolean; signal?: AbortSignal };
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === 'object' ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const terminal = (status: unknown) => ['finished', 'failed', 'cancelled'].includes(String(status));
const healthy = (status: unknown) => /^running:healthy(?::|$)/.test(String(status));
const immutable = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new Error('invalid resource identifier');
  return value;
};

export function preparationCompose(images: string[]): string {
  return JSON.stringify({ services: Object.fromEntries(images.map((image, i) => [i ? 'web-image' : 'api-image', {
    image, entrypoint: ['/bin/sh', '-c', 'sleep 1800'], restart: 'no', read_only: true,
    cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], mem_limit: '32m', cpus: '0.10',
    healthcheck: { test: ['CMD', '/bin/sh', '-c', 'true'], interval: '5s', timeout: '2s', retries: 3, start_period: '1s' },
  }])) });
}

export async function deployRelease(config: Config, t: RolloutTransport): Promise<void> {
  if (!immutable(config.sha)) throw new Error('release must be a full immutable commit SHA');
  const appIds = [uuid(config.api), uuid(config.web)];
  if (appIds[0] === appIds[1] || !/^[a-zA-Z0-9-]{1,80}$/.test(config.run)) throw new Error('invalid release configuration');
  let deadline = Date.now() + 20 * 60_000, recovering = false;
  const checkpoint = () => {
    if (Date.now() >= deadline || (!recovering && config.signal?.aborted)) throw new Error('rollout interrupted or timed out');
  };
  const pause = async (ms = 5_000) => { checkpoint(); await t.sleep(ms); checkpoint(); };
  const get = async (path: string) => row(await t.request('GET', path));
  const list = async (id: string) => {
    const value = await t.request('GET', `/deployments/applications/${id}`);
    return Array.isArray(value) ? rows(value) : rows(row(value).deployments);
  };
  const apps: Row[] = [];
  for (const id of appIds) {
    const app = await get(`/applications/${id}`);
    if (app.build_pack !== 'dockerimage' || !healthy(app.status) || !immutable(app.docker_registry_image_tag)) throw new Error(`application ${id} must be healthy with an immutable previous tag`);
    if (Number(app.additional_servers_count ?? 0) > 0) throw new Error('multi-server rollout requires a separate preparation plan');
    if ((await list(id)).some(d => !terminal(d.status))) throw new Error(`application ${id} already has an active deployment`);
    apps.push(app);
  }
  const destination = row(apps[0]!.destination), environment = row(apps[0]!.environment);
  if (row(apps[1]!.destination).uuid !== destination.uuid) throw new Error('applications must share a Docker destination');
  const images = apps.map((app, index) => {
    const name = app.docker_registry_image_name;
    if (typeof name !== 'string' || !new RegExp(`^ghcr\\.io/[a-z0-9-]+/reomi-${index ? 'web' : 'api'}$`).test(name)) throw new Error('unexpected application image');
    return `${name}:${config.sha}`;
  });
  const previous = apps.map(app => app.docker_registry_image_tag as string);
  t.log(`Previous release: API ${previous[0]}, web ${previous[1]}`);
  let preparationId: string | undefined, mutated = false, webMutated = false, unknownDeployment = false;
  const active = new Set<string>();
  const preparationName = `reomi-prepare-${config.run}`;
  const cancelActive = async () => {
    if (unknownDeployment) throw new Error('deployment outcome unknown; refusing competing rollback');
    for (const id of [...active]) {
      if (!terminal((await get(`/deployments/${id}`)).status)) {
        await t.request('POST', `/deployments/${id}/cancel`);
        let finished = false;
        for (let i = 0; i < 24; i++) {
          if (terminal((await get(`/deployments/${id}`)).status)) { finished = true; break; }
          await pause();
        }
        if (!finished) throw new Error(`deployment ${id} did not cancel; refusing competing rollback`);
      }
      active.delete(id);
    }
  };
  const stop = async (id: string) => {
    await t.request('POST', `/applications/${id}/stop?docker_cleanup=false`);
    for (let i = 0; i < 30; i++) {
      if (/^(exited|stopped)/.test(String((await get(`/applications/${id}`)).status))) return;
      await pause(2_000);
    }
    throw new Error(`old application ${id} did not stop`);
  };
  const replace = async (id: string, tag: string) => {
    checkpoint();
    const known = new Set((await list(id)).map(d => d.deployment_uuid));
    await t.request('PATCH', `/applications/${id}`, { docker_registry_image_tag: tag });
    let deployment: Row | undefined;
    try {
      deployment = rows(row(await t.request('POST', `/deploy?uuid=${id}`)).deployments)[0];
    } catch {
      // POST may have been accepted; reconcile instead of submitting a second job.
    }
    if (!deployment?.deployment_uuid) {
      for (let i = 0; i < 6; i++) {
        const discovered = (await list(id)).filter(d => !known.has(d.deployment_uuid));
        for (const d of discovered) active.add(uuid(d.deployment_uuid));
        if (discovered.length > 1) throw new Error(`ambiguous deployment for ${id}`);
        if (discovered.length === 1) { deployment = discovered[0]; break; }
        await pause();
      }
    }
    if (!deployment?.deployment_uuid) { unknownDeployment = true; throw new Error(`deployment outcome unknown for ${id}`); }
    const deploymentId = uuid(deployment.deployment_uuid); active.add(deploymentId);
    t.log(`Deploying ${id}: ${deploymentId}`);
    let finished = false;
    for (let i = 0; i < 60; i++) {
      checkpoint();
      const state = (await get(`/deployments/${deploymentId}`)).status;
      if (terminal(state)) {
        active.delete(deploymentId);
        if (state !== 'finished') throw new Error(`deployment ${deploymentId} ${state}`);
        finished = true; break;
      }
      await pause();
    }
    if (!finished) throw new Error(`deployment ${deploymentId} timed out`);
    for (let i = 0; i < 30; i++) {
      const app = await get(`/applications/${id}`);
      if (healthy(app.status) && app.docker_registry_image_tag === tag) return;
      await pause();
    }
    throw new Error(`application ${id} did not become healthy`);
  };
  try {
    checkpoint();
    try {
      preparationId = uuid(row(await t.request('POST', '/services', {
        name: preparationName, description: `Temporary image preparation for Reomi ${config.sha}`,
        project_uuid: uuid(row(environment.project).uuid), environment_uuid: uuid(environment.uuid),
        server_uuid: uuid(row(destination.server).uuid), destination_uuid: uuid(destination.uuid),
        instant_deploy: false,
        docker_compose_raw: Buffer.from(preparationCompose(images)).toString('base64'),
      })).uuid);
    } catch {
      const services = rows(await t.request('GET', '/services')).filter(s => s.name === preparationName);
      if (services.length === 1) preparationId = uuid(services[0]!.uuid);
      else throw new Error('preparation creation failed; production untouched');
    }
    t.log(`Preparation service: ${preparationId}`);
    let ready = false;
    for (let attempt = 0; attempt < 3 && !ready; attempt++) {
      checkpoint();
      await t.request('POST', `/services/${preparationId}/start`);
      for (let i = 0; i < 30; i++) {
        const components = rows((await get(`/services/${preparationId}`)).applications);
        ready = ['api-image', 'web-image'].every((name, index) => components.some(c => c.name === name && c.image === images[index] && healthy(c.status)));
        if (ready) break;
        await pause();
      }
      if (!ready) await pause((attempt + 1) * 5_000);
    }
    if (!ready) throw new Error('image preparation failed; production untouched');
    t.log('Both images prepared on the production Docker server');
    if (config.prepareOnly) return;
    // Recheck after lengthy pulls: never stop a release another operator changed.
    for (let i = 0; i < appIds.length; i++) {
      const current = await get(`/applications/${appIds[i]}`);
      if (current.docker_registry_image_tag !== previous[i] || !healthy(current.status) || (await list(appIds[i]!)).some(d => !terminal(d.status))) throw new Error('production changed during preparation; refusing to drain');
    }
    checkpoint(); mutated = true;
    await stop(appIds[0]!);
    await replace(appIds[0]!, config.sha);
    webMutated = true;
    await replace(appIds[1]!, config.sha);
    t.log('Release healthy: API and web');
  } catch (error) {
    if (!mutated) throw error;
    recovering = true; deadline = Date.now() + 12 * 60_000;
    t.log('Release failed; restoring previous tags immediately');
    try {
      await cancelActive();
      // A newer web must not keep writing while the API is rolled back.
      if (webMutated) await stop(appIds[1]!);
      await stop(appIds[0]!);
      for (let i = 0; i < appIds.length; i++) await t.request('PATCH', `/applications/${appIds[i]}`, { docker_registry_image_tag: previous[i] });
      const failed: string[] = [];
      for (let i = 0; i < appIds.length; i++) {
        if (i === 1 && !webMutated) continue;
        let restored = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          try { await replace(appIds[i]!, previous[i]!); restored = true; break; }
          catch { await cancelActive(); if (attempt === 0) await pause(5_000); }
        }
        if (!restored) failed.push(appIds[i]!);
      }
      if (failed.length) throw new Error(`unhealthy ${failed.join(', ')}`);
    } catch {
      throw new Error(`rollout failed; recovery failed for ${appIds.join(', ')}; inspect Coolify immediately`);
    }
    throw new Error('rollout failed; previous release restored');
  } finally {
    if (preparationId) {
      try { await t.request('DELETE', `/services/${preparationId}?docker_cleanup=false&delete_volumes=false&delete_connected_networks=true&delete_configurations=true`); }
      catch { t.log(`::warning::Remove temporary preparation service ${preparationId}; keep cached images`); }
    }
  }
}

if (import.meta.main) {
  const base = process.env.COOLIFY_URL, token = process.env.COOLIFY_TOKEN;
  if (base !== 'https://coolify.anvgrptools.ru/api/v1' || !token) throw new Error('configured Coolify destination and credential required');
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
  const transport: RolloutTransport = {
    log: message => console.log(message), sleep: ms => Bun.sleep(ms),
    request: async (method, path, body) => {
      const response = await fetch(`${base}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }).catch(() => { throw new Error(`Coolify ${method} request failed`); });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Coolify ${method} returned HTTP ${response.status}`); }
      return response.json();
    },
  };
  try {
    await deployRelease({ api: process.env.API_APP_UUID ?? 'u6kweu7gzzw9kidpuq7i0n7y', web: process.env.WEB_APP_UUID ?? 'tmc5k98iayyj0g28qr7inbaj',
      sha: process.env.GITHUB_SHA ?? '', run: `${process.env.GITHUB_RUN_ID ?? Date.now()}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`,
      prepareOnly: process.argv.includes('--prepare-only'), signal: controller.signal }, transport);
  } catch (error) { console.error(`::error::${error instanceof Error ? error.message : 'rollout failed'}`); process.exitCode = 1; }
}

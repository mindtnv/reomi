import { describe, expect, test } from 'bun:test';
import { deployRelease, preparationCompose, type RolloutTransport } from './deploy-coolify';

const old = 'a'.repeat(40), next = 'b'.repeat(40);
const config = { api: 'api', web: 'web', sha: next, run: 'test-123' };

function fixture(fail: 'prepare' | 'api' | 'web' | 'recovery' | 'uncertain' | 'timeout' | '' = '') {
  const calls: string[] = [];
  const tags: Record<string, string> = { api: old, web: old };
  const status: Record<string, string> = { api: 'running:healthy', web: 'running:healthy' };
  const deployments: Array<{ deployment_uuid: string; application_uuid: string; status: string }> = [];
  let number = 0, preparation: Record<string, unknown> | undefined;
  const transport: RolloutTransport = {
    sleep: async () => {}, log: () => {},
    request: async (method, path, body) => {
      calls.push(`${method} ${path}`);
      if (path === '/services' && method === 'POST') { preparation = body; return { uuid: 'prep' }; }
      if (path === '/services/prep' && method === 'GET') return { applications: ['api-image', 'web-image'].map((name, i) => ({ name, image: `ghcr.io/mindtnv/reomi-${i ? 'web' : 'api'}:${next}`, status: fail === 'prepare' ? 'exited' : 'running:healthy:excluded' })) };
      if (path.startsWith('/services/')) return {};
      if (path.startsWith('/deployments/applications/')) return { deployments: deployments.filter(d => d.application_uuid === path.split('/').at(-1)) };
      if (path.startsWith('/deployments/') && path.endsWith('/cancel')) {
        deployments.find(d => d.deployment_uuid === path.split('/')[2])!.status = 'cancelled'; return {};
      }
      if (path.startsWith('/deployments/')) return deployments.find(d => d.deployment_uuid === path.split('/')[2]);
      if (path.startsWith('/deploy?')) {
        const uuid = new URL(`https://fake${path}`).searchParams.get('uuid')!;
        const fails = tags[uuid] === next && (fail === uuid || fail === 'recovery') || tags[uuid] === old && fail === 'recovery';
        const d = { deployment_uuid: `d${++number}`, application_uuid: uuid, status: fail === 'timeout' && tags[uuid] === next ? 'in_progress' : fails ? 'failed' : 'finished' };
        deployments.push(d);
        if (d.status === 'finished') status[uuid] = 'running:healthy';
        if (fail === 'uncertain' && number === 1) throw new Error('response_lost');
        return { deployments: [d] };
      }
      const uuid = path.split('/')[2]!;
      if (path.includes('/stop')) { status[uuid] = 'exited'; return {}; }
      if (method === 'PATCH') { tags[uuid] = body!.docker_registry_image_tag as string; return {}; }
      return {
        uuid, status: status[uuid], build_pack: 'dockerimage', docker_registry_image_name: `ghcr.io/mindtnv/reomi-${uuid}`,
        docker_registry_image_tag: tags[uuid], additional_servers_count: 0,
        destination: { uuid: 'destination', server: { uuid: 'server' } },
        environment: { uuid: 'environment', project: { uuid: 'project' } },
      };
    },
  };
  return { transport, calls, tags, status, deployments, preparation: () => preparation };
}

describe('production rollout recovery', () => {
  test('preparation cannot run application entrypoints or expose secrets, mounts or ports', () => {
    const compose = JSON.parse(preparationCompose(['ghcr.io/mindtnv/reomi-api:'+next, 'ghcr.io/mindtnv/reomi-web:'+next]));
    for (const item of Object.values(compose.services) as Array<Record<string, unknown>>) {
      expect(item.entrypoint).toEqual(['/bin/sh', '-c', 'sleep 1800']);
      expect(item).not.toHaveProperty('environment'); expect(item).not.toHaveProperty('volumes'); expect(item).not.toHaveProperty('ports');
      expect(item.read_only).toBe(true);
    }
  });
  test('prepares both images before draining and completes API before web', async () => {
    const f = fixture(); await deployRelease(config, f.transport);
    expect(f.tags).toEqual({ api: next, web: next });
    expect(f.calls.indexOf('GET /services/prep')).toBeLessThan(f.calls.indexOf('POST /applications/api/stop?docker_cleanup=false'));
    expect(f.calls.indexOf('GET /deployments/d1')).toBeLessThan(f.calls.indexOf('PATCH /applications/web'));
    expect(f.calls.at(-1)).toContain('DELETE /services/prep?');
  });
  test('preparation-only never patches or stops production', async () => {
    const f = fixture(); await deployRelease({ ...config, prepareOnly: true }, f.transport);
    expect(f.calls.some(x => x.startsWith('PATCH') || x.includes('/stop'))).toBe(false);
  });
  test('exhausted preparation leaves production untouched and cleans only owned resources', async () => {
    const f = fixture('prepare'); await expect(deployRelease(config, f.transport)).rejects.toThrow('preparation');
    expect(f.tags).toEqual({ api: old, web: old });
    expect(f.calls.some(x => x.includes('/stop') || x.startsWith('PATCH'))).toBe(false);
    expect(f.calls.at(-1)).toContain('docker_cleanup=false');
  });
  for (const component of ['api', 'web'] as const) test(`${component} failure restores the previous healthy release immediately`, async () => {
    const f = fixture(component); await expect(deployRelease(config, f.transport)).rejects.toThrow('previous release restored');
    expect(f.tags).toEqual({ api: old, web: old });
    expect(f.status).toEqual({ api: 'running:healthy', web: 'running:healthy' });
  });
  test('lost deployment response reconciles accepted work without enqueueing twice', async () => {
    const f = fixture('uncertain'); await deployRelease(config, f.transport);
    expect(f.deployments).toHaveLength(2);
  });
  test('timed-out deployment is cancelled before rollback patches tags', async () => {
    const f = fixture('timeout'); await expect(deployRelease(config, f.transport)).rejects.toThrow('previous release restored');
    const cancel = f.calls.indexOf('POST /deployments/d1/cancel');
    expect(cancel).toBeGreaterThan(-1);
    expect(f.calls.slice(cancel+1)).toContain('PATCH /applications/api');
  });
  test('failed recovery is explicit and never reported as a successful release', async () => {
    const f = fixture('recovery'); await expect(deployRelease(config, f.transport)).rejects.toThrow('recovery failed');
    expect(f.calls.at(-1)).toContain('DELETE /services/prep?');
  });
  test('preparation refuses a changed production tag before any stop', async () => {
    const f = fixture(); const request = f.transport.request;
    f.transport.request = async (method, path, body) => {
      const result = await request(method, path, body);
      if (method === 'GET' && path === '/services/prep') f.tags.api = 'c'.repeat(40);
      return result;
    };
    await expect(deployRelease(config, f.transport)).rejects.toThrow('production changed');
    expect(f.calls.some(x => x.includes('/stop'))).toBe(false);
  });
  test('unconfirmed cancellation prevents a competing rollback', async () => {
    const f = fixture('timeout'); const request = f.transport.request;
    f.transport.request = async (method, path, body) => path.endsWith('/cancel') ? {} : request(method, path, body);
    await expect(deployRelease(config, f.transport)).rejects.toThrow('recovery failed');
    expect(f.tags.api).toBe(next);
    expect(f.deployments).toHaveLength(1);
  });
  test('termination after drain enters recovery instead of leaving the API stopped', async () => {
    const f = fixture(); const request = f.transport.request; const controller = new AbortController();
    f.transport.request = async (method, path, body) => {
      const result = await request(method, path, body);
      if (path.includes('/stop')) controller.abort();
      return result;
    };
    await expect(deployRelease({ ...config, signal: controller.signal }, f.transport)).rejects.toThrow('previous release restored');
    expect(f.tags).toEqual({ api: old, web: old }); expect(f.status.api).toBe('running:healthy');
  });
});

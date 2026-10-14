import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// ---- minimal chainable fake of the supabase-js query builder ----------------
type Call = {
  table: string;
  op: 'select' | 'insert' | 'update';
  payload?: unknown;
  filters: unknown[][];
};
type Result = { data: unknown; error: { message: string } | null; count?: number | null };

const calls: Call[] = [];
let resolver: (call: Call) => Result = () => ({ data: null, error: null });

function chain(table: string) {
  const call: Call = { table, op: 'select', filters: [] };
  calls.push(call);
  const settle = () => Promise.resolve(resolver(call));
  const api: Record<string, unknown> = {
    select: () => api,
    insert: (p: unknown) => {
      call.op = 'insert';
      call.payload = p;
      return api;
    },
    update: (p: unknown) => {
      call.op = 'update';
      call.payload = p;
      return api;
    },
    maybeSingle: settle,
    single: settle,
    then: (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej),
  };
  for (const f of ['eq', 'in', 'lt', 'order', 'limit']) {
    api[f] = (...args: unknown[]) => {
      call.filters.push([f, ...args]);
      return api;
    };
  }
  return api;
}

const getClaims = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims }, from: chain }),
}));

import { POST as jobAction } from '@/app/api/v1/jobs/[id]/[action]/route';
import { POST as createJob } from '@/app/api/v1/jobs/route';

const OWNER = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const JOB = '11111111-1111-4111-8111-111111111111';

const jobRow = (over: Record<string, unknown> = {}) => ({
  id: JOB,
  owner_id: OWNER,
  asset_id: ASSET,
  preset_id: 'realesrgan-x2',
  params: {},
  state: 'QUEUED',
  attempt_id: null,
  attempt_count: 0,
  cancel_requested: false,
  stage: null,
  processed_frames: null,
  total_frames: null,
  heartbeat_at: null,
  output_key: null,
  output_meta: null,
  error_code: null,
  error_message: null,
  worker_info: null,
  created_at: '2026-10-14T12:00:00Z',
  started_at: null,
  finished_at: null,
  ...over,
});

const asset = (over: Record<string, unknown> = {}) => ({
  id: ASSET,
  state: 'READY',
  size_bytes: 1000,
  client_meta: { width: 1280, height: 720, duration: 10 },
  ...over,
});

const post = (body: unknown) =>
  new Request('http://x/api/v1/jobs', { method: 'POST', body: JSON.stringify(body) });
const ctx = (id: string, action: string) =>
  ({ params: Promise.resolve({ id, action }) }) as Parameters<typeof jobAction>[1];

beforeEach(() => {
  calls.length = 0;
  process.env.ALLOWED_EMAILS = 'owner@example.com';
  getClaims.mockResolvedValue({
    data: { claims: { sub: OWNER, email: 'owner@example.com' } },
    error: null,
  });
});

describe('POST /api/v1/jobs', () => {
  const create = (presetId = 'realesrgan-x2') => createJob(post({ assetId: ASSET, presetId }), undefined);

  /** asset lookup -> `a`; active-job count -> `active`; insert echoes the payload. */
  const setup = (a: unknown, active = 0) => {
    resolver = (c) => {
      if (c.table === 'assets') return { data: a, error: null };
      if (c.op === 'select') return { data: null, error: null, count: active };
      return { data: jobRow({ ...(c.payload as object) }), error: null };
    };
  };

  it('creates a QUEUED job with a params snapshot -> 201', async () => {
    setup(asset());
    const res = await create();
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      state: 'QUEUED',
      presetId: 'realesrgan-x2',
      assetId: ASSET,
      stale: false,
    });
    const insert = calls.find((c) => c.op === 'insert');
    expect(insert?.payload).toMatchObject({
      owner_id: OWNER,
      asset_id: ASSET,
      preset_id: 'realesrgan-x2',
      state: 'QUEUED',
      params: { model: 'RealESRGAN_x2plus', scale: 2 },
    });
  });

  it('400 on invalid body', async () => {
    setup(asset());
    const res = await createJob(post({ assetId: 'nope' }), undefined);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('404 when the asset is not found, 409 when not READY', async () => {
    setup(null);
    expect((await create()).status).toBe(404);
    setup(asset({ state: 'UPLOADING' }));
    expect((await create()).status).toBe(409);
  });

  it('422 PRESET_UNKNOWN', async () => {
    setup(asset());
    const res = await create('nope');
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('PRESET_UNKNOWN');
  });

  it('422 PRESET_INCOMPATIBLE for 4x on 1080p, without inserting', async () => {
    setup(asset({ client_meta: { width: 1920, height: 1080 } }));
    const res = await create('realesrgan-x4');
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('PRESET_INCOMPATIBLE');
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('422 PRESET_TOO_SLOW for 540p 120 s on 4x, without inserting', async () => {
    setup(asset({ client_meta: { width: 960, height: 540, duration: 120 } }));
    const res = await create('realesrgan-x4');
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('PRESET_TOO_SLOW');
    expect(body.error.message).toContain('Fast 4× (ทั่วไป)');
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('429 TOO_MANY_ACTIVE_JOBS at 2 active jobs, without inserting', async () => {
    setup(asset(), 2);
    const res = await create();
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('TOO_MANY_ACTIVE_JOBS');
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('allows a new job with 1 active', async () => {
    setup(asset(), 1);
    expect((await create()).status).toBe(201);
  });

  it('401 without a session', async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    expect((await create()).status).toBe(401);
  });
});

describe('POST /api/v1/jobs/[id]/[action]', () => {
  const run = (id: string, action: string) =>
    jobAction(new Request('http://x', { method: 'POST' }), ctx(id, action));

  /** select -> `current`; update -> `updated` (null = lost race). */
  const setup = (
    current: Record<string, unknown> | null,
    updated: Record<string, unknown> | null,
  ) => {
    resolver = (c) =>
      c.op === 'update' ? { data: updated, error: null } : { data: current, error: null };
  };

  it('404 for unknown actions and bad ids, before touching the DB', async () => {
    setup(jobRow(), jobRow());
    expect((await run(JOB, 'delete')).status).toBe(404);
    expect((await run('not-a-uuid', 'cancel')).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED'])(
    'cancel %s -> 409 NOT_CANCELLABLE, no update',
    async (state) => {
      setup(jobRow({ state }), null);
      const res = await run(JOB, 'cancel');
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('NOT_CANCELLABLE');
      expect(calls.some((c) => c.op === 'update')).toBe(false);
    },
  );

  it('cancel QUEUED -> CANCELLED via conditional update', async () => {
    setup(jobRow(), jobRow({ state: 'CANCELLED', finished_at: '2026-10-14T12:01:00Z' }));
    const res = await run(JOB, 'cancel');
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('CANCELLED');
    const upd = calls.find((c) => c.op === 'update');
    expect(upd?.payload).toMatchObject({ state: 'CANCELLED' });
    expect(upd?.filters).toContainEqual(['eq', 'state', 'QUEUED']);
  });

  it('cancel RUNNING -> cancelRequested true', async () => {
    setup(jobRow({ state: 'RUNNING' }), jobRow({ state: 'RUNNING', cancel_requested: true }));
    const body = await (await run(JOB, 'cancel')).json();
    expect(body).toMatchObject({ state: 'RUNNING', cancelRequested: true });
  });

  it('cancel that loses a race (0 rows, then terminal) -> 409', async () => {
    let reads = 0;
    resolver = (c) => {
      if (c.op === 'update') return { data: null, error: null };
      reads++;
      return { data: jobRow({ state: reads === 1 ? 'RUNNING' : 'SUCCEEDED' }), error: null };
    };
    const res = await run(JOB, 'cancel');
    expect(res.status).toBe(409);
    expect(reads).toBe(2);
  });

  it('404 when the job does not exist', async () => {
    setup(null, null);
    expect((await run(JOB, 'cancel')).status).toBe(404);
  });

  it('requeue FAILED -> QUEUED', async () => {
    setup(jobRow({ state: 'FAILED' }), jobRow({ state: 'QUEUED' }));
    const res = await run(JOB, 'requeue');
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.op === 'update')?.payload).toMatchObject({
      state: 'QUEUED',
      attempt_id: null,
      cancel_requested: false,
    });
  });

  it('requeue fresh RUNNING -> 409; stale RUNNING -> guarded by heartbeat_at', async () => {
    setup(jobRow({ state: 'RUNNING', heartbeat_at: new Date().toISOString() }), null);
    expect((await run(JOB, 'requeue')).status).toBe(409);

    calls.length = 0;
    const old = new Date(Date.now() - 4 * 60_000).toISOString();
    setup(jobRow({ state: 'RUNNING', heartbeat_at: old }), jobRow({ state: 'QUEUED' }));
    expect((await run(JOB, 'requeue')).status).toBe(200);
    const upd = calls.find((c) => c.op === 'update');
    expect(upd?.filters.some((f) => f[0] === 'lt' && f[1] === 'heartbeat_at')).toBe(true);
  });

  it.each(['QUEUED', 'SUCCEEDED', 'CANCELLED'])('requeue %s -> 409', async (state) => {
    setup(jobRow({ state }), null);
    expect((await run(JOB, 'requeue')).status).toBe(409);
  });
});

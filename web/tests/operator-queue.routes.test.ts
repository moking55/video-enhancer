import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

type Call = { table: string; filters: unknown[][] };
type Result = { data: unknown; error: { message: string } | null };

const calls: Call[] = [];
let tables: Record<string, unknown[]> = {};

function chain(table: string) {
  const call: Call = { table, filters: [] };
  calls.push(call);
  const settle = () => Promise.resolve<Result>({ data: tables[table] ?? [], error: null });
  const api: Record<string, unknown> = {
    select: () => api,
    then: (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej),
  };
  for (const f of ['eq', 'in', 'gte', 'order', 'limit']) {
    api[f] = (...args: unknown[]) => {
      call.filters.push([f, ...args]);
      return api;
    };
  }
  return api;
}

const listUsers = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: chain, auth: { admin: { listUsers } } }),
}));

const getClaims = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims } }),
}));

import { GET } from '@/app/api/v1/operator/queue/route';
import { QueueItem } from '@/lib/contracts/queue';

const OP = '22222222-2222-4222-8222-222222222222';
const FRIEND = '99999999-9999-4999-8999-999999999999';
const ASSET = '33333333-3333-4333-8333-333333333333';
const JOB_Q = '11111111-1111-4111-8111-111111111111';
const JOB_R = '11111111-1111-4111-8111-222222222222';

const jobRow = (over: Record<string, unknown>) => ({
  id: JOB_Q,
  owner_id: FRIEND,
  asset_id: ASSET,
  preset_id: 'realesrgan-x2',
  state: 'QUEUED',
  stage: null,
  processed_frames: null,
  total_frames: null,
  heartbeat_at: null,
  started_at: null,
  created_at: '2026-10-14T00:00:00Z',
  ...over,
});

const as = (sub: string, email: string) =>
  getClaims.mockResolvedValue({ data: { claims: { sub, email } }, error: null });
const get = () => GET(new Request('http://x/api/v1/operator/queue'), undefined);

beforeEach(() => {
  calls.length = 0;
  process.env.ALLOWED_EMAILS = 'owner@example.com,friend@example.com';
  process.env.OPERATOR_EMAILS = 'owner@example.com';
  listUsers.mockReset();
  listUsers.mockResolvedValue({
    data: {
      users: [
        { id: OP, email: 'owner@example.com' },
        { id: FRIEND, email: 'friend@example.com' },
      ],
    },
    error: null,
  });
  tables = {};
});

describe('GET /api/v1/operator/queue', () => {
  it('403 for a non-operator, no data access', async () => {
    as(FRIEND, 'friend@example.com');
    const res = await get();
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(listUsers).not.toHaveBeenCalled();
  });

  it('401 when unauthenticated', async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: 'no session' } });
    expect((await get()).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('operator gets every owner\'s jobs with email + filename and no secrets', async () => {
    as(OP, 'owner@example.com');
    tables = {
      jobs: [
        jobRow({}),
        jobRow({
          id: JOB_R,
          owner_id: OP,
          state: 'RUNNING',
          stage: 'enhance',
          processed_frames: 5,
          total_frames: 10,
          // no heartbeat for far longer than the stale threshold
          heartbeat_at: '2020-01-01T00:00:00Z',
        }),
      ],
      assets: [{ id: ASSET, filename: 'clip.mp4' }],
    };
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const { jobs } = (await res.json()) as { jobs: unknown[] };
    const parsed = jobs.map((j) => QueueItem.parse(j));

    // the fake returns the same rows for the active and the finished query
    expect(parsed.length).toBeGreaterThanOrEqual(2);
    const queued = parsed.find((j) => j.id === JOB_Q);
    expect(queued).toEqual({
      id: JOB_Q,
      state: 'QUEUED',
      presetId: 'realesrgan-x2',
      stage: null,
      processedFrames: null,
      totalFrames: null,
      stale: false,
      createdAt: '2026-10-14T00:00:00Z',
      ownerEmail: 'friend@example.com',
      filename: 'clip.mp4',
    });
    const running = parsed.find((j) => j.id === JOB_R);
    expect(running).toMatchObject({
      state: 'RUNNING',
      stage: 'enhance',
      processedFrames: 5,
      totalFrames: 10,
      stale: true,
      ownerEmail: 'owner@example.com',
    });

    const text = JSON.stringify(jobs);
    expect(text).not.toMatch(/https?:|object_key|attempt_id|owner_id|inputs\//);
    // no owner scoping on the query (it deliberately crosses owners)
    expect(calls.some((c) => c.filters.some((f) => f[1] === 'owner_id'))).toBe(false);
  });

  it('queries QUEUED/RUNNING plus the last 20 finished in 24 h', async () => {
    as(OP, 'owner@example.com');
    await get();
    const jobCalls = calls.filter((c) => c.table === 'jobs');
    expect(jobCalls).toHaveLength(2);
    expect(jobCalls[0].filters).toContainEqual(['in', 'state', ['QUEUED', 'RUNNING']]);
    expect(jobCalls[1].filters).toContainEqual([
      'in',
      'state',
      ['SUCCEEDED', 'FAILED', 'CANCELLED'],
    ]);
    expect(jobCalls[1].filters).toContainEqual(['limit', 20]);
    expect(jobCalls[1].filters.some((f) => f[0] === 'gte' && f[1] === 'finished_at')).toBe(true);
  });

  it('empty queue skips the asset and user lookups', async () => {
    as(OP, 'owner@example.com');
    const res = await get();
    expect(await res.json()).toEqual({ jobs: [] });
    expect(calls.some((c) => c.table === 'assets')).toBe(false);
    expect(listUsers).not.toHaveBeenCalled();
  });
});

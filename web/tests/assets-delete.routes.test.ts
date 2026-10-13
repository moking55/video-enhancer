import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

type Call = {
  table: string;
  op: 'select' | 'delete';
  filters: unknown[][];
};
type Result = { data: unknown; error: { message: string } | null };

const calls: Call[] = [];
let resolver: (call: Call) => Result = () => ({ data: null, error: null });

function chain(table: string) {
  const call: Call = { table, op: 'select', filters: [] };
  calls.push(call);
  const settle = () => Promise.resolve(resolver(call));
  const api: Record<string, unknown> = {
    select: () => api,
    delete: () => {
      call.op = 'delete';
      return api;
    },
    maybeSingle: settle,
    then: (res: (v: Result) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej),
  };
  for (const f of ['eq']) {
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

const deleteObjects = vi.fn();
vi.mock('@/lib/storage', () => ({
  outputKey: (jobId: string, attemptId: string) => `outputs/${jobId}/${attemptId}.mp4`,
  deleteObjects: (...a: unknown[]) => deleteObjects(...a),
}));

import { DELETE } from '@/app/api/v1/assets/[id]/route';

const OWNER = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const JOB_A = '44444444-4444-4444-8444-444444444444';
const JOB_B = '55555555-5555-4555-8555-555555555555';
const ATTEMPT = '66666666-6666-4666-8666-666666666666';

const assetRow = { id: ASSET, object_key: `inputs/${ASSET}.mp4` };

let jobs: unknown[] = [];
let assetRowResult: unknown = assetRow;
let deleteResult: Result = { data: null, error: null };

const del = (id: string = ASSET) =>
  DELETE(
    new Request(`http://x/api/v1/assets/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) } as Parameters<typeof DELETE>[1],
  );

beforeEach(() => {
  calls.length = 0;
  deleteObjects.mockReset();
  deleteObjects.mockResolvedValue(undefined);
  jobs = [];
  assetRowResult = assetRow;
  deleteResult = { data: null, error: null };
  resolver = (call) => {
    if (call.table === 'assets' && call.op === 'delete') return deleteResult;
    if (call.table === 'assets') return { data: assetRowResult, error: null };
    return { data: jobs, error: null };
  };
  process.env.ALLOWED_EMAILS = 'owner@example.com';
  getClaims.mockResolvedValue({
    data: { claims: { sub: OWNER, email: 'owner@example.com' } },
    error: null,
  });
});

const assetDeleted = () => calls.some((c) => c.table === 'assets' && c.op === 'delete');

describe('DELETE /api/v1/assets/[id]', () => {
  it('404 for a malformed id or an asset the owner does not have', async () => {
    expect((await del('not-a-uuid')).status).toBe(404);
    assetRowResult = null;
    const res = await del();
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
    expect(deleteObjects).not.toHaveBeenCalled();
    expect(assetDeleted()).toBe(false);
    // Ownership is part of the query, not checked afterwards.
    expect(calls[0]?.filters).toContainEqual(['eq', 'owner_id', OWNER]);
  });

  it('409 ASSET_BUSY when a job is RUNNING; nothing is deleted', async () => {
    jobs = [
      { id: JOB_A, state: 'SUCCEEDED', output_key: 'outputs/a/x.mp4', attempt_id: null },
      { id: JOB_B, state: 'RUNNING', output_key: null, attempt_id: ATTEMPT },
    ];
    const res = await del();
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('ASSET_BUSY');
    expect(deleteObjects).not.toHaveBeenCalled();
    expect(assetDeleted()).toBe(false);
  });

  it('204: deletes input + output + attempt keys, then the row (QUEUED does not block)', async () => {
    jobs = [
      { id: JOB_A, state: 'SUCCEEDED', output_key: `outputs/${JOB_A}/a1.mp4`, attempt_id: 'a1' },
      { id: JOB_B, state: 'QUEUED', output_key: null, attempt_id: null },
    ];
    const res = await del();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    expect(deleteObjects).toHaveBeenCalledTimes(1);
    const keys = deleteObjects.mock.calls[0]![0] as string[];
    expect(keys.sort()).toEqual([`inputs/${ASSET}.mp4`, `outputs/${JOB_A}/a1.mp4`].sort());

    const row = calls.find((c) => c.table === 'assets' && c.op === 'delete');
    expect(row?.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'id', ASSET],
        ['eq', 'owner_id', OWNER],
      ]),
    );
  });

  it('includes the attempt key of a failed job that never recorded output_key', async () => {
    jobs = [{ id: JOB_A, state: 'FAILED', output_key: null, attempt_id: ATTEMPT }];
    expect((await del()).status).toBe(204);
    expect(deleteObjects.mock.calls[0]![0]).toEqual([
      `inputs/${ASSET}.mp4`,
      `outputs/${JOB_A}/${ATTEMPT}.mp4`,
    ]);
  });

  it('502 STORAGE_DELETE_FAILED keeps the row', async () => {
    deleteObjects.mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await del();
    errSpy.mockRestore();
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe('STORAGE_DELETE_FAILED');
    expect(assetDeleted()).toBe(false);
  });
});

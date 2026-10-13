import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// ---- minimal chainable fake of the supabase-js query builder ----------------
type Call = {
  table: string;
  op: 'select' | 'insert' | 'update';
  payload?: unknown;
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
  for (const f of ['eq', 'neq', 'in', 'order', 'limit']) {
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

const presignPut = vi.fn();
const headObject = vi.fn();
vi.mock('@/lib/storage', () => ({
  inputKey: (id: string) => `inputs/${id}.mp4`,
  presignPut: (...a: unknown[]) => presignPut(...a),
  headObject: (...a: unknown[]) => headObject(...a),
}));

import { GET as listAssets } from '@/app/api/v1/assets/route';
import { POST as completeUpload } from '@/app/api/v1/assets/[id]/complete/route';
import { POST as createUpload } from '@/app/api/v1/uploads/route';

const OWNER = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const MIB = 1024 * 1024;

const assetRow = (over: Record<string, unknown> = {}) => ({
  id: ASSET,
  owner_id: OWNER,
  object_key: `inputs/${ASSET}.mp4`,
  filename: 'clip.mp4',
  size_bytes: 1000,
  state: 'UPLOADING',
  client_meta: { width: 1280, height: 720, duration: 10 },
  probe: null,
  created_at: '2026-10-14T12:00:00Z',
  ...over,
});

const post = (body: unknown) =>
  new Request('http://x/api/v1/uploads', { method: 'POST', body: JSON.stringify(body) });
const validBody = (over: Record<string, unknown> = {}) => ({
  filename: 'clip.mp4',
  sizeBytes: 1000,
  contentType: 'video/mp4',
  clientMeta: { width: 1280, height: 720, durationSec: 10 },
  ...over,
});
const complete = (id: string) =>
  completeUpload(
    new Request(`http://x/api/v1/assets/${id}/complete`, { method: 'POST' }),
    { params: Promise.resolve({ id }) } as Parameters<typeof completeUpload>[1],
  );

beforeEach(() => {
  calls.length = 0;
  presignPut.mockReset();
  headObject.mockReset();
  presignPut.mockResolvedValue('http://storage/put?sig=1');
  resolver = () => ({ data: null, error: null });
  process.env.ALLOWED_EMAILS = 'owner@example.com';
  getClaims.mockResolvedValue({
    data: { claims: { sub: OWNER, email: 'owner@example.com' } },
    error: null,
  });
});

describe('POST /api/v1/uploads', () => {
  it('creates an UPLOADING asset and returns a signed PUT -> 201', async () => {
    const res = await createUpload(post(validBody({ filename: '../a/b\u0000.mp4' })), undefined);
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.putUrl).toBe('http://storage/put?sig=1');
    expect(body.headers).toEqual({ 'Content-Type': 'video/mp4' });
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now() + 800_000);

    const insert = calls.find((c) => c.op === 'insert');
    expect(insert?.table).toBe('assets');
    expect(insert?.payload).toMatchObject({
      id: body.assetId,
      owner_id: OWNER,
      object_key: `inputs/${body.assetId}.mp4`,
      filename: '.._a_b.mp4',
      size_bytes: 1000,
      state: 'UPLOADING',
      client_meta: { width: 1280, height: 720, duration: 10 },
    });
    expect(presignPut).toHaveBeenCalledWith(`inputs/${body.assetId}.mp4`, 'video/mp4', 900);
  });

  it('413 TOO_LARGE above 500 MiB, 500 MiB itself is accepted', async () => {
    const big = await createUpload(post(validBody({ sizeBytes: 500 * MIB + 1 })), undefined);
    expect(big.status).toBe(413);
    expect((await big.json()).error.code).toBe('TOO_LARGE');
    expect(calls.some((c) => c.op === 'insert')).toBe(false);

    const ok = await createUpload(post(validBody({ sizeBytes: 500 * MIB })), undefined);
    expect(ok.status).toBe(201);
  });

  it('415 UNSUPPORTED_TYPE for other content types', async () => {
    const res = await createUpload(post(validBody({ contentType: 'video/webm' })), undefined);
    expect(res.status).toBe(415);
    expect((await res.json()).error.code).toBe('UNSUPPORTED_TYPE');
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('400 on invalid body', async () => {
    for (const body of [
      validBody({ filename: '' }),
      validBody({ sizeBytes: 0 }),
      validBody({ sizeBytes: 1.5 }),
      validBody({ clientMeta: { width: -1 } }),
      validBody({ contentType: undefined }),
    ]) {
      const res = await createUpload(post(body), undefined);
      expect(res.status).toBe(400);
    }
    const bad = await createUpload(
      new Request('http://x', { method: 'POST', body: '{nope' }),
      undefined,
    );
    expect(bad.status).toBe(400);
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('401 without a session', async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: 'no session' } });
    const res = await createUpload(post(validBody()), undefined);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/assets/[id]/complete', () => {
  /** select -> `row`; the conditional update echoes the payload on top of it. */
  const setup = (row: unknown) => {
    resolver = (c) => {
      if (c.op === 'update') return { data: { ...(row as object), ...(c.payload as object) }, error: null };
      return { data: row, error: null };
    };
  };

  it('409 UPLOAD_MISSING when nothing was uploaded', async () => {
    setup(assetRow());
    headObject.mockResolvedValue(null);
    const res = await complete(ASSET);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('UPLOAD_MISSING');
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('409 UPLOAD_SIZE_MISMATCH when sizes differ', async () => {
    setup(assetRow());
    headObject.mockResolvedValue({ size: 999 });
    const res = await complete(ASSET);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('UPLOAD_SIZE_MISMATCH');
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('marks READY with a conditional UPLOADING -> READY update -> 200', async () => {
    setup(assetRow());
    headObject.mockResolvedValue({ size: 1000 });
    const res = await complete(ASSET);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: ASSET,
      state: 'READY',
      sizeBytes: 1000,
      filename: 'clip.mp4',
      clientMeta: { width: 1280, height: 720, durationSec: 10 },
    });
    expect(headObject).toHaveBeenCalledWith(`inputs/${ASSET}.mp4`);
    const update = calls.find((c) => c.op === 'update');
    expect(update?.payload).toEqual({ state: 'READY' });
    expect(update?.filters).toContainEqual(['eq', 'state', 'UPLOADING']);
    expect(update?.filters).toContainEqual(['eq', 'owner_id', OWNER]);
  });

  it('is idempotent for an already READY asset (no HEAD, no update)', async () => {
    setup(assetRow({ state: 'READY' }));
    const res = await complete(ASSET);
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('READY');
    expect(headObject).not.toHaveBeenCalled();
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('409 for a DELETED asset', async () => {
    setup(assetRow({ state: 'DELETED' }));
    const res = await complete(ASSET);
    expect(res.status).toBe(409);
  });

  it('404 for an unknown or foreign asset (and a non-uuid id)', async () => {
    setup(null);
    const res = await complete(ASSET);
    expect(res.status).toBe(404);
    const select = calls.find((c) => c.op === 'select');
    expect(select?.filters).toContainEqual(['eq', 'owner_id', OWNER]);

    expect((await complete('not-a-uuid')).status).toBe(404);
    expect(headObject).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/assets', () => {
  it('lists the owner newest-first, limit 50, excluding DELETED, with latest job', async () => {
    const rows = [
      assetRow({ id: ASSET, state: 'READY' }),
      assetRow({ id: '44444444-4444-4444-8444-444444444444', state: 'DELETED' }),
      assetRow({ id: '55555555-5555-4555-8555-555555555555', state: 'UPLOADING' }),
    ];
    resolver = (c) => {
      if (c.table === 'assets') {
        const excludes = c.filters.find((f) => f[0] === 'neq' && f[1] === 'state')?.[2];
        return { data: rows.filter((r) => r.state !== excludes), error: null };
      }
      return {
        data: [
          { id: 'j2', asset_id: ASSET, preset_id: 'realesrgan-x2', state: 'RUNNING', created_at: 'b' },
          { id: 'j1', asset_id: ASSET, preset_id: 'realesrgan-x2', state: 'FAILED', created_at: 'a' },
        ],
        error: null,
      };
    };

    const res = await listAssets(new Request('http://x/api/v1/assets'), undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const { assets } = await res.json();
    expect(assets.map((a: { id: string }) => a.id)).toEqual([
      ASSET,
      '55555555-5555-4555-8555-555555555555',
    ]);
    expect(assets[0].latestJob).toMatchObject({ id: 'j2', state: 'RUNNING' });
    expect(assets[1].latestJob).toBeNull();
    expect(assets[0]).not.toHaveProperty('object_key');

    const q = calls.find((c) => c.table === 'assets');
    expect(q?.filters).toContainEqual(['eq', 'owner_id', OWNER]);
    expect(q?.filters).toContainEqual(['neq', 'state', 'DELETED']);
    expect(q?.filters).toContainEqual(['order', 'created_at', { ascending: false }]);
    expect(q?.filters).toContainEqual(['limit', 50]);
  });

  it('skips the jobs query when there are no assets', async () => {
    resolver = () => ({ data: [], error: null });
    const res = await listAssets(new Request('http://x/api/v1/assets'), undefined);
    expect(await res.json()).toEqual({ assets: [] });
    expect(calls.map((c) => c.table)).toEqual(['assets']);
  });
});

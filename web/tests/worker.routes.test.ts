import { createHash } from 'node:crypto';

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
const rpc = vi.fn();
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
  for (const f of ['eq', 'is', 'in', 'order', 'limit']) {
    api[f] = (...args: unknown[]) => {
      call.filters.push([f, ...args]);
      return api;
    };
  }
  return api;
}

const getUserById = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: chain, rpc, auth: { admin: { getUserById } } }),
}));

const getClaims = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims }, from: chain }),
}));

vi.mock('@/lib/storage', () => ({
  inputKey: (id: string) => `inputs/${id}.mp4`,
  presignGet: vi.fn(async (key: string) => `https://rustfs.example.test/bucket/${key}?sig=x`),
}));

import { POST as claim } from '@/app/api/v1/worker/claim/route';
import { GET as getTokenInfo, POST as createToken } from '@/app/api/v1/worker-tokens/route';
import { ClaimResponse } from '@/lib/contracts/worker';
import { generateWorkerToken, hashWorkerToken } from '@/lib/worker-tokens';

const OWNER = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const JOB = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '44444444-4444-4444-8444-444444444444';
const TOKEN_ID = '55555555-5555-4555-8555-555555555555';

const GOOD_TOKEN = generateWorkerToken();

const claimReq = (body?: unknown, token: string | null = GOOD_TOKEN) =>
  new Request('http://x/api/v1/worker/claim', {
    method: 'POST',
    headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const jobRow = (over: Record<string, unknown> = {}) => ({
  id: JOB,
  owner_id: OWNER,
  asset_id: ASSET,
  preset_id: 'realesrgan-x2',
  params: { model: 'RealESRGAN_x2plus', scale: 2 },
  state: 'RUNNING',
  attempt_id: ATTEMPT,
  attempt_count: 1,
  ...over,
});

const assetRow = (over: Record<string, unknown> = {}) => ({
  id: ASSET,
  filename: 'clip.mp4',
  size_bytes: 12345,
  object_key: `inputs/${ASSET}.mp4`,
  state: 'READY',
  ...over,
});

/** token lookup -> valid (unless `tokenValid` false); assets -> `asset`. */
function setup({ tokenValid = true, asset = assetRow() as unknown } = {}) {
  resolver = (c) => {
    if (c.table === 'worker_tokens') {
      return {
        data: tokenValid ? { id: TOKEN_ID, owner_id: OWNER } : null,
        error: null,
      };
    }
    if (c.table === 'assets') return { data: asset, error: null };
    return { data: null, error: null };
  };
}

beforeEach(() => {
  calls.length = 0;
  rpc.mockReset();
  process.env.ALLOWED_EMAILS = 'owner@example.com,friend@example.com';
  process.env.OPERATOR_EMAILS = 'owner@example.com';
  getUserById.mockReset();
  getUserById.mockResolvedValue({ data: { user: { email: 'Owner@Example.com' } }, error: null });
  getClaims.mockResolvedValue({
    data: { claims: { sub: OWNER, email: 'owner@example.com' } },
    error: null,
  });
  setup();
});

describe('worker auth', () => {
  it('401 INVALID_WORKER_TOKEN without Authorization, no DB access', async () => {
    const res = await claim(claimReq({}, null), undefined);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('INVALID_WORKER_TOKEN');
    expect(calls).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('401 for a malformed token, no DB access', async () => {
    expect((await claim(claimReq({}, 've_short'), undefined)).status).toBe(401);
    expect((await claim(claimReq({}, 'not-a-token'), undefined)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('401 for a revoked/unknown token (lookup filters revoked_at is null by hash)', async () => {
    setup({ tokenValid: false });
    const res = await claim(claimReq({}), undefined);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('INVALID_WORKER_TOKEN');
    const lookup = calls.find((c) => c.table === 'worker_tokens');
    expect(lookup?.filters).toContainEqual(['eq', 'token_sha256', hashWorkerToken(GOOD_TOKEN)]);
    expect(lookup?.filters).toContainEqual(['is', 'revoked_at', null]);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('worker auth: owner must still be an operator', () => {
  it('401 when the token owner is no longer an operator, before claiming', async () => {
    getUserById.mockResolvedValue({ data: { user: { email: 'friend@example.com' } }, error: null });
    const res = await claim(claimReq({}), undefined);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('INVALID_WORKER_TOKEN');
    expect(getUserById).toHaveBeenCalledWith(OWNER);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('401 when OPERATOR_EMAILS is unset (fail closed)', async () => {
    delete process.env.OPERATOR_EMAILS;
    expect((await claim(claimReq({}), undefined)).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('401 when getUserById errors (fail closed)', async () => {
    getUserById.mockResolvedValue({ data: { user: null }, error: { message: 'down' } });
    const res = await claim(claimReq({}), undefined);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('INVALID_WORKER_TOKEN');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('401 when the user has no email', async () => {
    getUserById.mockResolvedValue({ data: { user: {} }, error: null });
    expect((await claim(claimReq({}), undefined)).status).toBe(401);
  });

  it('operator check is case-insensitive and lets the claim proceed', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect((await claim(claimReq({}), undefined)).status).toBe(204);
    expect(rpc).toHaveBeenCalled();
  });
});

describe('POST /api/v1/worker/claim', () => {
  it('204 with no body when nothing is queued', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const res = await claim(claimReq({ presets: ['realesrgan-x2'] }), undefined);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(rpc).toHaveBeenCalledWith('claim_job', { p_presets: ['realesrgan-x2'] });
  });

  it('204 without calling claim_job when no requested preset is offered', async () => {
    const res = await claim(claimReq({ presets: ['nope'] }), undefined);
    expect(res.status).toBe(204);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('empty body claims across all offered presets', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await claim(claimReq(), undefined);
    const args = rpc.mock.calls[0][1] as { p_presets: string[] };
    expect(args.p_presets).toEqual(expect.arrayContaining(['realesrgan-x2', 'realesrgan-x4']));
  });

  it('400 on invalid body', async () => {
    const res = await claim(claimReq({ gpu: { name: 'T4' } }), undefined);
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('200 matching ClaimResponse, stores worker_info, presigned inputUrl', async () => {
    rpc.mockResolvedValue({ data: [jobRow()], error: null });
    const gpu = { name: 'Tesla T4', vramMb: 15360 };
    const res = await claim(claimReq({ presets: ['realesrgan-x2'], gpu }), undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    const body = ClaimResponse.parse(await res.json());
    expect(body).toMatchObject({
      jobId: JOB,
      attemptId: ATTEMPT,
      preset: { id: 'realesrgan-x2', model: 'RealESRGAN_x2plus', scale: 2 },
      input: { assetId: ASSET, sizeBytes: 12345, filename: 'clip.mp4' },
    });
    expect(body.inputUrl).toContain(`inputs/${ASSET}.mp4`);

    const upd = calls.find((c) => c.table === 'jobs' && c.op === 'update');
    expect(upd?.payload).toEqual({ worker_info: { gpu } });
    expect(upd?.filters).toContainEqual(['eq', 'attempt_id', ATTEMPT]);
    // asset lookup follows the job (any owner), not the operator
    const assetCall = calls.find((c) => c.table === 'assets');
    expect(assetCall?.filters).toContainEqual(['eq', 'id', ASSET]);
    expect(assetCall?.filters.some((f) => f[1] === 'owner_id')).toBe(false);
  });

  it('operator claims a job owned by another user', async () => {
    const FRIEND = '99999999-9999-4999-8999-999999999999';
    rpc.mockResolvedValue({ data: [jobRow({ owner_id: FRIEND })], error: null });
    const res = await claim(claimReq({}), undefined);
    expect(res.status).toBe(200);
    expect(ClaimResponse.parse(await res.json()).jobId).toBe(JOB);
    expect(calls.some((c) => c.filters.some((f) => f[1] === 'owner_id' && f[2] === OWNER))).toBe(
      false,
    );
  });

  it('missing asset -> job FAILED ASSET_MISSING + 409', async () => {
    setup({ asset: null });
    rpc.mockResolvedValue({ data: [jobRow()], error: null });
    const res = await claim(claimReq({}), undefined);
    expect(res.status).toBe(409);
    const upd = calls.find((c) => c.table === 'jobs' && c.op === 'update');
    expect(upd?.payload).toMatchObject({ state: 'FAILED', error_code: 'ASSET_MISSING' });
  });

  it('500 when claim_job errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect((await claim(claimReq({}), undefined)).status).toBe(500);
  });
});

describe('/api/v1/worker-tokens', () => {
  it('POST revokes old tokens, stores only the sha256, returns ve_ token once', async () => {
    resolver = (c) =>
      c.op === 'insert'
        ? { data: { created_at: '2026-10-14T12:00:00Z' }, error: null }
        : { data: null, error: null };

    const res = await createToken(new Request('http://x', { method: 'POST' }), undefined);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^ve_[A-Za-z0-9_-]{43}$/);
    expect(body.createdAt).toBe('2026-10-14T12:00:00Z');

    const [revoke, insert] = calls;
    expect(revoke.op).toBe('update');
    expect(revoke.payload).toHaveProperty('revoked_at');
    expect(revoke.filters).toContainEqual(['eq', 'owner_id', OWNER]);
    expect(revoke.filters).toContainEqual(['is', 'revoked_at', null]);

    expect(insert.op).toBe('insert');
    const stored = insert.payload as { owner_id: string; token_sha256: string };
    expect(stored.owner_id).toBe(OWNER);
    expect(stored.token_sha256).toBe(createHash('sha256').update(body.token).digest('hex'));
    expect(JSON.stringify(insert.payload)).not.toContain(body.token);
  });

  it('POST/GET 403 for an allowed non-operator user, without touching the DB', async () => {
    getClaims.mockResolvedValue({
      data: { claims: { sub: OWNER, email: 'friend@example.com' } },
      error: null,
    });
    const post = await createToken(new Request('http://x', { method: 'POST' }), undefined);
    expect(post.status).toBe(403);
    expect((await post.json()).error.code).toBe('FORBIDDEN');
    expect((await getTokenInfo(new Request('http://x'), undefined)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('POST 401 without a session, 403 for another email', async () => {
    getClaims.mockResolvedValue({ data: null, error: null });
    const req = () => new Request('http://x', { method: 'POST' });
    expect((await createToken(req(), undefined)).status).toBe(401);
    getClaims.mockResolvedValue({
      data: { claims: { sub: OWNER, email: 'other@example.com' } },
      error: null,
    });
    expect((await createToken(req(), undefined)).status).toBe(403);
  });

  it('GET reports active + createdAt without any hash', async () => {
    resolver = () => ({
      data: { created_at: '2026-10-14T12:00:00Z' },
      error: null,
    });
    const res = await getTokenInfo(new Request('http://x'), undefined);
    expect(await res.json()).toEqual({ active: true, createdAt: '2026-10-14T12:00:00Z' });

    resolver = () => ({ data: null, error: null });
    const none = await getTokenInfo(new Request('http://x'), undefined);
    expect(await none.json()).toEqual({ active: false, createdAt: null });
  });
});

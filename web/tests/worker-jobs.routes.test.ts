import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// ---- minimal chainable fake of the supabase-js query builder ----------------
type Call = {
  table: string;
  op: 'select' | 'update';
  payload?: Record<string, unknown>;
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
    update: (p: Record<string, unknown>) => {
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

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: chain,
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: { email: 'owner@example.com' } }, error: null }),
      },
    },
  }),
}));

const headObject = vi.fn();
const presignPut = vi.fn();
vi.mock('@/lib/storage', () => ({
  outputKey: (jobId: string, attemptId: string) => `outputs/${jobId}/${attemptId}.mp4`,
  headObject: (key: string) => headObject(key),
  presignPut: (...args: unknown[]) => presignPut(...args),
}));

import { POST } from '@/app/api/v1/worker/jobs/[id]/[action]/route';
import { OUTPUT_URL_TTL_SEC, OutputUrlResponse } from '@/lib/contracts/worker';
import { generateWorkerToken } from '@/lib/worker-tokens';

// The job belongs to FRIEND; the token belongs to OWNER (the operator).
const FRIEND = '99999999-9999-4999-8999-999999999999';
const OWNER = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const JOB = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '44444444-4444-4444-8444-444444444444';
const OLD_ATTEMPT = '66666666-6666-4666-8666-666666666666';
const TOKEN_ID = '55555555-5555-4555-8555-555555555555';
const TOKEN = generateWorkerToken();

const OUTPUT_META = {
  width: 3840,
  height: 2160,
  frames: 100,
  fps: 30,
  durationSec: 3.33,
  hasAudio: true,
  sizeBytes: 5000,
};

type JobState = {
  owner_id: string;
  asset_id: string;
  state: string;
  attempt_id: string | null;
  cancel_requested: boolean;
};
let job: JobState | null;

const fresh = (over: Partial<JobState> = {}): JobState => ({
  owner_id: FRIEND,
  asset_id: ASSET,
  state: 'RUNNING',
  attempt_id: ATTEMPT,
  cancel_requested: false,
  ...over,
});

const matches = (c: Call) =>
  c.filters.every(([f, col, val]) => {
    if (f !== 'eq' || !job) return true;
    if (col === 'id') return val === JOB;
    return (job as unknown as Record<string, unknown>)[col as string] === val;
  });

/** Stateful fake of the jobs table: conditional updates only apply when filters match. */
function setup() {
  resolver = (c) => {
    if (c.table === 'worker_tokens') return { data: { id: TOKEN_ID, owner_id: OWNER }, error: null };
    if (c.table === 'assets') return { data: null, error: null };
    if (c.table === 'jobs') {
      if (c.op === 'select') return { data: job && matches(c) ? { ...job } : null, error: null };
      if (!job || !matches(c)) return { data: null, error: null };
      Object.assign(job, c.payload);
      return { data: { ...job }, error: null };
    }
    return { data: null, error: null };
  };
}

const req = (action: string, body: unknown, token: string | null = TOKEN, id = JOB) =>
  POST(
    new Request(`http://x/api/v1/worker/jobs/${id}/${action}`, {
      method: 'POST',
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id, action }) } as never,
  );

const bodies: Record<string, unknown> = {
  heartbeat: { attemptId: OLD_ATTEMPT, stage: 'enhance' },
  'output-url': { attemptId: OLD_ATTEMPT },
  complete: { attemptId: OLD_ATTEMPT, outputMeta: OUTPUT_META },
  fail: { attemptId: OLD_ATTEMPT, code: 'OOM', message: 'out of memory' },
};

const jobUpdates = () => calls.filter((c) => c.table === 'jobs' && c.op === 'update');

beforeEach(() => {
  process.env.OPERATOR_EMAILS = 'owner@example.com';
  calls.length = 0;
  headObject.mockReset();
  presignPut.mockReset();
  presignPut.mockResolvedValue('https://rustfs.example.test/put?sig=x');
  job = fresh();
  setup();
});

describe('POST /api/v1/worker/jobs/[id]/[action]', () => {
  it('401 without a valid token, no job access', async () => {
    const res = await req('heartbeat', bodies.heartbeat, null);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('INVALID_WORKER_TOKEN');
    expect(calls.some((c) => c.table === 'jobs')).toBe(false);
  });

  it('404 for an unknown action, before any DB access', async () => {
    const res = await req('cancel', {});
    expect(res.status).toBe(404);
    expect(calls.filter((c) => c.table !== 'worker_tokens')).toHaveLength(0);
  });

  it('404 for a non-uuid id and for a job that does not exist', async () => {
    expect((await req('heartbeat', bodies.heartbeat, TOKEN, 'nope')).status).toBe(404);
    job = null;
    const res = await req('heartbeat', { attemptId: ATTEMPT, stage: 'enhance' });
    expect(res.status).toBe(404);
  });

  it('400 on invalid JSON / invalid body', async () => {
    expect((await req('heartbeat', '{nope')).status).toBe(400);
    expect((await req('heartbeat', { attemptId: ATTEMPT, stage: 'dance' })).status).toBe(400);
    expect(jobUpdates()).toHaveLength(0);
  });

  it.each(['heartbeat', 'output-url', 'complete', 'fail'])(
    'stale attemptId -> 409 STALE_ATTEMPT for %s, nothing written',
    async (action) => {
      headObject.mockResolvedValue({ size: OUTPUT_META.sizeBytes });
      const res = await req(action, bodies[action]);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('STALE_ATTEMPT');
      expect(jobUpdates()).toHaveLength(0);
      expect(presignPut).not.toHaveBeenCalled();
    },
  );

  it.each(['heartbeat', 'output-url', 'complete'])(
    'job no longer RUNNING -> 409 STALE_ATTEMPT for %s',
    async (action) => {
      job = fresh({ state: 'QUEUED', attempt_id: null });
      const body = { ...(bodies[action] as object), attemptId: ATTEMPT };
      const res = await req(action, body);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('STALE_ATTEMPT');
    },
  );

  describe('heartbeat', () => {
    it('updates progress + heartbeat_at with a fenced write and returns cancelRequested', async () => {
      const res = await req('heartbeat', {
        attemptId: ATTEMPT,
        stage: 'enhance',
        processedFrames: 10,
        totalFrames: 100,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cancelRequested: false });

      const [upd] = jobUpdates();
      expect(upd.payload).toMatchObject({ stage: 'enhance', processed_frames: 10, total_frames: 100 });
      expect(typeof upd.payload?.heartbeat_at).toBe('string');
      expect(upd.filters.some((f) => f[1] === 'owner_id')).toBe(false);
      expect(upd.filters).toEqual(
        expect.arrayContaining([
          ['eq', 'id', JOB],
          ['eq', 'attempt_id', ATTEMPT],
          ['eq', 'state', 'RUNNING'],
        ]),
      );
    });

    it('returns cancelRequested true when the user asked to cancel', async () => {
      job = fresh({ cancel_requested: true });
      const res = await req('heartbeat', { attemptId: ATTEMPT, stage: 'enhance' });
      expect(await res.json()).toEqual({ cancelRequested: true });
    });

    it('does not null out frame counters that were not sent', async () => {
      await req('heartbeat', { attemptId: ATTEMPT, stage: 'download' });
      expect(jobUpdates()[0].payload).not.toHaveProperty('processed_frames');
      expect(jobUpdates()[0].payload).not.toHaveProperty('total_frames');
    });

    it('stores probe on the job asset only for stage probe', async () => {
      const probe = { width: 1280, height: 720 };
      await req('heartbeat', { attemptId: ATTEMPT, stage: 'enhance', probe });
      expect(calls.some((c) => c.table === 'assets')).toBe(false);

      await req('heartbeat', { attemptId: ATTEMPT, stage: 'probe', probe });
      const assetUpd = calls.find((c) => c.table === 'assets' && c.op === 'update');
      expect(assetUpd?.payload).toEqual({ probe });
      expect(assetUpd?.filters).toEqual(
        expect.arrayContaining([
          ['eq', 'id', ASSET],
        ]),
      );
    });
  });

  describe('output-url', () => {
    it('presigns a PUT for outputs/{job}/{attempt}.mp4 and returns the signed headers', async () => {
      const res = await req('output-url', { attemptId: ATTEMPT });
      expect(res.status).toBe(200);
      const body = OutputUrlResponse.parse(await res.json());
      expect(body.headers).toEqual({ 'Content-Type': 'video/mp4' });
      expect(presignPut).toHaveBeenCalledWith(
        `outputs/${JOB}/${ATTEMPT}.mp4`,
        'video/mp4',
        OUTPUT_URL_TTL_SEC,
      );
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('complete', () => {
    const body = { attemptId: ATTEMPT, outputMeta: OUTPUT_META };

    it('409 OUTPUT_MISSING when the object was not uploaded', async () => {
      headObject.mockResolvedValue(null);
      const res = await req('complete', body);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('OUTPUT_MISSING');
      expect(headObject).toHaveBeenCalledWith(`outputs/${JOB}/${ATTEMPT}.mp4`);
      expect(jobUpdates()).toHaveLength(0);
      expect(job?.state).toBe('RUNNING');
    });

    it('409 OUTPUT_SIZE_MISMATCH when HEAD size differs from outputMeta', async () => {
      headObject.mockResolvedValue({ size: 1 });
      const res = await req('complete', body);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('OUTPUT_SIZE_MISMATCH');
      expect(job?.state).toBe('RUNNING');
    });

    it('operator completes a job owned by another user: happy path -> SUCCEEDED with output_key, output_meta, finished_at, stage null', async () => {
      headObject.mockResolvedValue({ size: OUTPUT_META.sizeBytes });
      const res = await req('complete', body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state: 'SUCCEEDED' });
      expect(job?.state).toBe('SUCCEEDED');
      const [upd] = jobUpdates();
      expect(upd.payload).toMatchObject({
        state: 'SUCCEEDED',
        stage: null,
        output_key: `outputs/${JOB}/${ATTEMPT}.mp4`,
        output_meta: OUTPUT_META,
      });
      expect(typeof upd.payload?.finished_at).toBe('string');
      expect(calls.some((c) => c.filters.some((f) => f[1] === 'owner_id'))).toBe(false);
      expect(upd.filters).toEqual(
        expect.arrayContaining([
          ['eq', 'attempt_id', ATTEMPT],
          ['eq', 'state', 'RUNNING'],
        ]),
      );
    });

    it('cancel_requested -> CANCELLED (never SUCCEEDED) and 409 CANCELLED', async () => {
      job = fresh({ cancel_requested: true });
      headObject.mockResolvedValue({ size: OUTPUT_META.sizeBytes });
      const res = await req('complete', body);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('CANCELLED');
      expect(job?.state).toBe('CANCELLED');
      expect(jobUpdates().some((c) => c.payload?.state === 'SUCCEEDED')).toBe(false);
      expect(typeof jobUpdates()[0].payload?.finished_at).toBe('string');
    });

    it('a cancel landing between read and write still wins over SUCCEEDED', async () => {
      headObject.mockImplementation(async () => {
        // user hits Cancel while the server is checking the object
        if (job) job.cancel_requested = true;
        return { size: OUTPUT_META.sizeBytes };
      });
      // The initial read saw cancel_requested=false (read happens before HEAD).
      const res = await req('complete', body);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('CANCELLED');
      expect(job?.state).toBe('CANCELLED');
    });

    it('duplicate complete after success -> 200 SUCCEEDED, no second write', async () => {
      headObject.mockResolvedValue({ size: OUTPUT_META.sizeBytes });
      expect((await req('complete', body)).status).toBe(200);
      const writes = jobUpdates().length;

      const again = await req('complete', body);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ state: 'SUCCEEDED' });
      expect(jobUpdates()).toHaveLength(writes);
    });

    it('a different attempt on a SUCCEEDED job is stale', async () => {
      job = fresh({ state: 'SUCCEEDED' });
      const res = await req('complete', { ...body, attemptId: OLD_ATTEMPT });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('STALE_ATTEMPT');
    });
  });

  describe('fail', () => {
    it('CANCELLED code -> CANCELLED without error fields', async () => {
      const res = await req('fail', { attemptId: ATTEMPT, code: 'CANCELLED', message: 'stopped' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state: 'CANCELLED' });
      const [upd] = jobUpdates();
      expect(upd.payload).toMatchObject({ state: 'CANCELLED' });
      expect(upd.payload).not.toHaveProperty('error_code');
      expect(typeof upd.payload?.finished_at).toBe('string');
    });

    it('other codes -> FAILED with error_code and message truncated to 2000', async () => {
      const res = await req('fail', { attemptId: ATTEMPT, code: 'OOM', message: 'x'.repeat(2000) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state: 'FAILED' });
      const [upd] = jobUpdates();
      expect(upd.payload).toMatchObject({ state: 'FAILED', error_code: 'OOM' });
      expect((upd.payload?.error_message as string).length).toBe(2000);
      expect(typeof upd.payload?.finished_at).toBe('string');
    });

    it('duplicate fail -> 200 with the current terminal state', async () => {
      await req('fail', { attemptId: ATTEMPT, code: 'OOM', message: 'oom' });
      const writes = jobUpdates().length;
      const again = await req('fail', { attemptId: ATTEMPT, code: 'OOM', message: 'oom' });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ state: 'FAILED' });
      expect(jobUpdates()).toHaveLength(writes);
    });
  });
});

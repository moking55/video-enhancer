import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

type Result = { data: unknown; error: { message: string } | null };
const tables: Record<string, Result> = {};
const filters: unknown[][] = [];

function chain(table: string) {
  const settle = () => Promise.resolve(tables[table] ?? { data: null, error: null });
  const api: Record<string, unknown> = { select: () => api, maybeSingle: settle };
  api.eq = (...a: unknown[]) => {
    filters.push([table, ...a]);
    return api;
  };
  return api;
}

const getClaims = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getClaims }, from: chain }),
}));

const presignGet = vi.fn(
  async (key: string, ttl?: number, name?: string) =>
    `https://s3.test/${key}?ttl=${ttl}${name ? `&name=${encodeURIComponent(name)}` : ''}`,
);
vi.mock('@/lib/storage', () => ({
  presignGet: (...args: [string, number?, string?]) => presignGet(...args),
}));

import { GET } from '@/app/api/v1/jobs/[id]/media/route';
import { fpsFromProbe, outputDownloadName, parseFps, resolveInputInfo } from '@/lib/media-info';

const OWNER = '22222222-2222-4222-8222-222222222222';
const JOB = '11111111-1111-4111-8111-111111111111';
const ASSET = '33333333-3333-4333-8333-333333333333';

const call = (id = JOB) =>
  GET(new Request(`http://x/api/v1/jobs/${id}/media`), {
    params: Promise.resolve({ id }),
  } as Parameters<typeof GET>[1]);

const job = (over: Record<string, unknown> = {}) => ({
  id: JOB,
  asset_id: ASSET,
  preset_id: 'realesrgan-x2',
  state: 'SUCCEEDED',
  output_key: `outputs/${JOB}/a.mp4`,
  output_meta: { fps: 25 },
  ...over,
});
const asset = (over: Record<string, unknown> = {}) => ({
  filename: 'holiday.clip.mov',
  object_key: `inputs/${ASSET}.mp4`,
  probe: { width: 640, height: 360, fpsRational: '30000/1001' },
  client_meta: { width: 1, height: 1 },
  ...over,
});

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  filters.length = 0;
  presignGet.mockClear();
  process.env.ALLOWED_EMAILS = 'owner@example.com';
  getClaims.mockResolvedValue({
    data: { claims: { sub: OWNER, email: 'owner@example.com' } },
    error: null,
  });
});

describe('GET /api/v1/jobs/[id]/media', () => {
  it('401 without a session', async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: 'no' } });
    expect((await call()).status).toBe(401);
  });

  it('404 for a non-uuid id or a job that is not the owner', async () => {
    expect((await call('nope')).status).toBe(404);
    tables.jobs = { data: null, error: null };
    expect((await call()).status).toBe(404);
    expect(filters).toContainEqual(['jobs', 'owner_id', OWNER]);
  });

  it('SUCCEEDED: signed input + output + download URL with a filename', async () => {
    tables.jobs = { data: job(), error: null };
    tables.assets = { data: asset(), error: null };
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = await res.json();
    expect(body.input.url).toContain(`inputs/${ASSET}.mp4?ttl=3600`);
    expect(body.input.width).toBe(640);
    expect(body.input.fps).toBeCloseTo(29.97, 2);
    expect(body.output.url).toContain(`outputs/${JOB}/a.mp4?ttl=3600`);
    expect(body.output.url).not.toContain('name=');
    expect(decodeURIComponent(body.output.downloadUrl)).toContain(
      'name=holiday.clip.realesrgan-x2.mp4',
    );
  });

  it('non-SUCCEEDED job has output null; fps falls back to output_meta', async () => {
    tables.jobs = { data: job({ state: 'RUNNING', output_key: null }), error: null };
    tables.assets = { data: asset({ probe: null }), error: null };
    const body = await (await call()).json();
    expect(body.output).toBeNull();
    expect(body.input.width).toBe(1);
    expect(body.input.fps).toBe(25);
  });
});

describe('media-info helpers', () => {
  it('parseFps handles rationals, strings and numbers', () => {
    expect(parseFps('30000/1001')).toBeCloseTo(29.97003, 4);
    expect(parseFps('25')).toBe(25);
    expect(parseFps(24)).toBe(24);
    expect(parseFps('0/0')).toBeUndefined();
    expect(parseFps('abc')).toBeUndefined();
    expect(parseFps(-1)).toBeUndefined();
    expect(parseFps(null)).toBeUndefined();
  });

  it('fpsFromProbe prefers fps then rational spellings', () => {
    expect(fpsFromProbe({ fps: 30, fpsRational: '25/1' })).toBe(30);
    expect(fpsFromProbe({ avg_frame_rate: '0/0', r_frame_rate: '24/1' })).toBe(24);
    expect(fpsFromProbe('x')).toBeUndefined();
  });

  it('resolveInputInfo omits unknown fields', () => {
    expect(resolveInputInfo(null, null, null)).toEqual({});
  });

  it('outputDownloadName strips the extension', () => {
    expect(outputDownloadName('a.b.mp4', 'p')).toBe('a.b.p.mp4');
    expect(outputDownloadName('noext', 'p')).toBe('noext.p.mp4');
  });
});

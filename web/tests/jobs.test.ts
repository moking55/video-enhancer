import { describe, expect, it } from 'vitest';

import {
  CreateJobRequest,
  isStale,
  JOB_STATES,
  ListJobsQuery,
  STALE_AFTER_MS,
  toJobDto,
  type JobRow,
} from '@/lib/contracts/jobs';
import { canCancel, canRequeue, cancelEffect, requeueUpdate } from '@/lib/jobs';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const row = (over: Partial<JobRow> = {}): JobRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  owner_id: '22222222-2222-4222-8222-222222222222',
  asset_id: '33333333-3333-4333-8333-333333333333',
  preset_id: 'realesrgan-x2',
  params: { model: 'RealESRGAN_x4plus' },
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
  created_at: ago(10 * 60_000),
  started_at: null,
  finished_at: null,
  ...over,
});

describe('cancel guards', () => {
  it('allows QUEUED and RUNNING only', () => {
    expect(JOB_STATES.filter(canCancel)).toEqual(['QUEUED', 'RUNNING']);
  });

  it('QUEUED -> CANCELLED immediately with finished_at', () => {
    expect(cancelEffect('QUEUED', NOW)).toEqual({
      type: 'CANCEL_NOW',
      update: { state: 'CANCELLED', finished_at: NOW.toISOString() },
    });
  });

  it('RUNNING -> sets cancel_requested only (worker acks later)', () => {
    expect(cancelEffect('RUNNING', NOW)).toEqual({
      type: 'REQUEST_CANCEL',
      update: { cancel_requested: true },
    });
  });

  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED', 'BOGUS'])('%s is not cancellable', (s) => {
    expect(cancelEffect(s, NOW)).toBeNull();
    expect(canCancel(s)).toBe(false);
  });
});

describe('requeue guards', () => {
  it('FAILED can be requeued', () => {
    expect(canRequeue(row({ state: 'FAILED' }), NOW)).toBe(true);
  });

  it('RUNNING only when stale', () => {
    expect(canRequeue(row({ state: 'RUNNING', heartbeat_at: ago(30_000) }), NOW)).toBe(false);
    expect(
      canRequeue(row({ state: 'RUNNING', heartbeat_at: ago(STALE_AFTER_MS + 1000) }), NOW),
    ).toBe(true);
  });

  it.each(['QUEUED', 'SUCCEEDED', 'CANCELLED'] as const)('%s cannot be requeued', (state) => {
    // even with an ancient heartbeat
    expect(canRequeue(row({ state, heartbeat_at: ago(60 * 60_000) }), NOW)).toBe(false);
  });

  it('update payload resets the job to a clean QUEUED row', () => {
    expect(requeueUpdate()).toEqual({
      state: 'QUEUED',
      attempt_id: null,
      stage: null,
      processed_frames: null,
      total_frames: null,
      heartbeat_at: null,
      error_code: null,
      error_message: null,
      cancel_requested: false,
      finished_at: null,
    });
  });
});

describe('stale computation', () => {
  const running = (heartbeat_at: string | null, started_at: string | null = null) =>
    row({ state: 'RUNNING', heartbeat_at, started_at });

  it('not stale at 2:59, stale at 3:01', () => {
    expect(isStale(running(ago(2 * 60_000 + 59_000)), NOW)).toBe(false);
    expect(isStale(running(ago(3 * 60_000 + 1_000)), NOW)).toBe(true);
  });

  it('exactly 3:00 is not yet stale (strictly older than 3 min)', () => {
    expect(isStale(running(ago(STALE_AFTER_MS)), NOW)).toBe(false);
  });

  it('falls back to started_at, and is stale with no signal at all', () => {
    expect(isStale(running(null, ago(60_000)), NOW)).toBe(false);
    expect(isStale(running(null, ago(4 * 60_000)), NOW)).toBe(true);
    expect(isStale(running(null, null), NOW)).toBe(true);
  });

  it('never stale for non-RUNNING states', () => {
    for (const state of ['QUEUED', 'SUCCEEDED', 'FAILED', 'CANCELLED']) {
      expect(isStale(row({ state, heartbeat_at: ago(60 * 60_000) }), NOW)).toBe(false);
    }
  });
});

describe('toJobDto', () => {
  it('maps snake_case rows to camelCase and hides internals', () => {
    const dto = toJobDto(
      row({
        state: 'RUNNING',
        attempt_id: '44444444-4444-4444-8444-444444444444',
        attempt_count: 2,
        stage: 'enhance',
        processed_frames: 10,
        total_frames: 100,
        heartbeat_at: ago(4 * 60_000),
        output_key: 'outputs/secret.mp4',
      }),
      NOW,
    );
    expect(dto).toMatchObject({
      assetId: '33333333-3333-4333-8333-333333333333',
      presetId: 'realesrgan-x2',
      state: 'RUNNING',
      attemptCount: 2,
      cancelRequested: false,
      processedFrames: 10,
      totalFrames: 100,
      stale: true,
    });
    expect(dto).not.toHaveProperty('attempt_id');
    expect(dto).not.toHaveProperty('attemptId');
    expect(JSON.stringify(dto)).not.toContain('secret.mp4');
  });
});

describe('request schemas', () => {
  const uuid = '33333333-3333-4333-8333-333333333333';

  it('CreateJobRequest requires a uuid assetId and a presetId', () => {
    expect(CreateJobRequest.safeParse({ assetId: uuid, presetId: 'realesrgan-x2' }).success).toBe(
      true,
    );
    expect(CreateJobRequest.safeParse({ assetId: 'nope', presetId: 'x' }).success).toBe(false);
    expect(CreateJobRequest.safeParse({ assetId: uuid }).success).toBe(false);
  });

  it('ListJobsQuery defaults and caps limit at 50', () => {
    expect(ListJobsQuery.parse({}).limit).toBe(20);
    expect(ListJobsQuery.parse({ limit: '50' }).limit).toBe(50);
    expect(ListJobsQuery.safeParse({ limit: '51' }).success).toBe(false);
    expect(ListJobsQuery.safeParse({ limit: '0' }).success).toBe(false);
  });
});

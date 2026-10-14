import { describe, expect, it } from 'vitest';

import { ASSET_STATUS_TEXT as T, deriveAssetStatus, hasActiveJob } from '@/components/asset-status';
import type { AssetDto, AssetJobSummary } from '@/lib/contracts/uploads';

const ID = '11111111-1111-4111-8111-111111111111';

function job(over: Partial<AssetJobSummary> = {}): AssetJobSummary {
  return {
    id: ID,
    presetId: 'realesrgan-x2',
    state: 'QUEUED',
    createdAt: 'a',
    stage: null,
    processedFrames: null,
    totalFrames: null,
    stale: false,
    cancelRequested: false,
    errorCode: null,
    ...over,
  };
}

function asset(state: AssetDto['state'], latestJob?: AssetJobSummary | null): AssetDto {
  return {
    id: ID,
    filename: 'a.mp4',
    sizeBytes: 1,
    state,
    clientMeta: {},
    probe: null,
    createdAt: 'a',
    latestJob,
  };
}

describe('deriveAssetStatus', () => {
  it('UPLOADING asset', () => {
    const s = deriveAssetStatus(asset('UPLOADING', null));
    expect(s.label).toBe(T.uploading);
    expect(s.actions).toMatchObject({ jobLink: null, enhance: null, cancel: false, deleteEnabled: true });
    expect(s.active).toBe(false);
  });

  it('UPLOADING wins over a job', () => {
    expect(deriveAssetStatus(asset('UPLOADING', job({ state: 'RUNNING' }))).label).toBe(T.uploading);
  });

  it('READY without a job', () => {
    for (const latest of [null, undefined]) {
      const s = deriveAssetStatus(asset('READY', latest));
      expect(s.label).toBe(T.ready);
      expect(s.actions).toMatchObject({ jobLink: null, enhance: 'enhance', cancel: false, deleteEnabled: true });
    }
  });

  it('QUEUED', () => {
    const s = deriveAssetStatus(asset('READY', job({ state: 'QUEUED' })));
    expect(s.label).toBe(T.queued);
    expect(s.active).toBe(true);
    expect(s.actions).toEqual({
      jobLink: 'progress',
      enhance: null,
      cancel: true,
      cancelDisabled: false,
      deleteEnabled: false,
      deleteDisabledReason: T.deleteBlockedActive,
    });
  });

  it('RUNNING with stage and frames', () => {
    const s = deriveAssetStatus(
      asset('READY', job({ state: 'RUNNING', stage: 'enhance', processedFrames: 25, totalFrames: 100 })),
    );
    expect(s.label).toBe(T.processing);
    expect(s.tone).toBe('info');
    expect(s.detail).toBe('กำลังปรับปรุงเฟรม · 25 / 100 เฟรม (25%)');
    expect(s.actions).toMatchObject({ jobLink: 'progress', cancel: true, enhance: null, deleteEnabled: false });
  });

  it('RUNNING without progress fields has no detail', () => {
    const s = deriveAssetStatus(asset('READY', job({ state: 'RUNNING' })));
    expect(s.label).toBe(T.processing);
    expect(s.detail).toBeNull();
  });

  it('RUNNING stale', () => {
    const s = deriveAssetStatus(asset('READY', job({ state: 'RUNNING', stale: true })));
    expect(s.label).toBe(T.stale);
    expect(s.tone).toBe('warning');
    expect(s.actions.cancel).toBe(true);
  });

  it('cancelRequested beats stale and disables Cancel', () => {
    const s = deriveAssetStatus(
      asset('READY', job({ state: 'RUNNING', stale: true, cancelRequested: true })),
    );
    expect(s.label).toBe(T.cancelling);
    expect(s.actions).toMatchObject({ cancel: true, cancelDisabled: true, deleteEnabled: false });
    expect(deriveAssetStatus(asset('READY', job({ cancelRequested: true }))).label).toBe(T.cancelling);
  });

  it('SUCCEEDED', () => {
    const s = deriveAssetStatus(asset('READY', job({ state: 'SUCCEEDED' })));
    expect(s.label).toBe(T.done);
    expect(s.tone).toBe('success');
    expect(s.active).toBe(false);
    expect(s.actions).toMatchObject({
      jobLink: 'compare',
      enhance: 'enhance-again',
      cancel: false,
      deleteEnabled: true,
      deleteDisabledReason: null,
    });
  });

  it('FAILED shows the error code', () => {
    const s = deriveAssetStatus(asset('READY', job({ state: 'FAILED', errorCode: 'OOM' })));
    expect(s.label).toBe(`${T.failed}: OOM`);
    expect(s.tone).toBe('danger');
    expect(s.actions).toMatchObject({ jobLink: 'details', enhance: 'enhance-again', deleteEnabled: true });
  });

  it('FAILED without a code', () => {
    expect(deriveAssetStatus(asset('READY', job({ state: 'FAILED' }))).label).toBe(T.failed);
  });

  it('CANCELLED', () => {
    const s = deriveAssetStatus(asset('READY', job({ state: 'CANCELLED' })));
    expect(s.label).toBe(T.cancelled);
    expect(s.actions).toMatchObject({ jobLink: 'details', enhance: 'enhance-again', cancel: false });
  });

  it('hasActiveJob', () => {
    expect(hasActiveJob(asset('READY', job({ state: 'QUEUED' })))).toBe(true);
    expect(hasActiveJob(asset('READY', job({ state: 'RUNNING' })))).toBe(true);
    expect(hasActiveJob(asset('READY', job({ state: 'FAILED' })))).toBe(false);
    expect(hasActiveJob(asset('READY', null))).toBe(false);
  });
});

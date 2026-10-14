import { describe, expect, it } from 'vitest';

import { checkClientLimits } from '@/lib/client-meta';

const MIB = 1024 * 1024;
const mp4 = (over: Partial<{ name: string; type: string; size: number }> = {}) => ({
  name: 'clip.mp4',
  type: 'video/mp4',
  size: 10 * MIB,
  ...over,
});

describe('checkClientLimits', () => {
  it('accepts a valid MP4 at the limits', () => {
    expect(
      checkClientLimits(mp4({ size: 500 * MIB }), { width: 1920, height: 1080, durationSec: 120 }),
    ).toEqual([]);
  });

  it('accepts portrait 1080x1920 and missing metadata', () => {
    expect(checkClientLimits(mp4(), { width: 1080, height: 1920 })).toEqual([]);
    expect(checkClientLimits(mp4(), {})).toEqual([]);
    expect(checkClientLimits(mp4())).toEqual([]);
  });

  it('accepts an empty type when the extension is .mp4', () => {
    expect(checkClientLimits(mp4({ type: '' }))).toEqual([]);
  });

  it('rejects non-MP4 by type or extension', () => {
    expect(checkClientLimits(mp4({ type: 'video/webm', name: 'a.webm' }))).toHaveLength(1);
    expect(checkClientLimits(mp4({ type: 'video/quicktime', name: 'a.mp4' }))).toHaveLength(1);
    expect(checkClientLimits(mp4({ type: 'video/mp4', name: 'a.mov' }))).toHaveLength(1);
  });

  it('rejects files over 500 MiB and empty files', () => {
    const big = checkClientLimits(mp4({ size: 500 * MIB + 1 }));
    expect(big).toHaveLength(1);
    expect(big[0]).toMatch(/500 MiB/);
    expect(checkClientLimits(mp4({ size: 0 }))).toHaveLength(1);
  });

  it('rejects duration above 120 s', () => {
    const msgs = checkClientLimits(mp4(), { durationSec: 120.5 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/121 วินาที/);
  });

  it('rejects resolution beyond 1920x1080 in either orientation', () => {
    expect(checkClientLimits(mp4(), { width: 3840, height: 2160 })).toHaveLength(1);
    expect(checkClientLimits(mp4(), { width: 2160, height: 3840 })).toHaveLength(1);
    expect(checkClientLimits(mp4(), { width: 1920, height: 1200 })).toHaveLength(1);
  });

  it('reports every violation at once', () => {
    const msgs = checkClientLimits(mp4({ type: 'video/webm', name: 'a.webm', size: 600 * MIB }), {
      width: 4000,
      height: 3000,
      durationSec: 300,
    });
    expect(msgs).toHaveLength(4);
  });
});

import { describe, expect, it } from 'vitest';

import { jobProgressDisplay, PROGRESS_DONE_TEXT, stageText } from '@/components/job-format';

const progress = (state: string, processedFrames: number | null, totalFrames: number | null) =>
  jobProgressDisplay({
    state: state as 'RUNNING',
    processedFrames,
    totalFrames,
  });

describe('jobProgressDisplay', () => {
  it('SUCCEEDED shows a full bar and "เสร็จแล้ว", never a stale partial count', () => {
    const p = progress('SUCCEEDED', 120, 200);
    expect(p.text).toBe(PROGRESS_DONE_TEXT);
    expect(p.text).toBe('เสร็จแล้ว');
    expect(p.bar).toEqual({ value: 1, max: 1 });
    expect(p.text).not.toMatch(/120/);
  });

  it('SUCCEEDED without any counters is still complete', () => {
    expect(progress('SUCCEEDED', null, null)).toEqual({
      bar: { value: 1, max: 1 },
      text: 'เสร็จแล้ว',
    });
  });

  it('RUNNING shows the bar and frame counter', () => {
    const p = progress('RUNNING', 25, 100);
    expect(p.bar).toEqual({ value: 25, max: 100 });
    expect(p.text).toBe('25 / 100 เฟรม (25%)');
  });

  it('RUNNING without a known total has no bar', () => {
    expect(progress('RUNNING', 10, null)).toEqual({ bar: null, text: '10 เฟรม' });
    expect(progress('RUNNING', null, null)).toEqual({ bar: null, text: null });
  });

  it.each(['FAILED', 'CANCELLED', 'QUEUED'])('%s hides the bar and counter', (state) => {
    expect(progress(state, 120, 200)).toEqual({ bar: null, text: null });
  });
});

describe('stageText', () => {
  it('labels the verify stage', () => {
    expect(stageText('verify')).toBe('กำลังตรวจผลลัพธ์');
  });
});

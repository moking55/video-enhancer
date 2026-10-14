import { describe, expect, it } from 'vitest';

import { checkPresetCompatibility, getPreset } from '@/lib/contracts/presets';
import {
  ERROR_MESSAGES,
  apiErrorText,
  errorMessageForCode,
  jobFailureText,
} from '@/lib/error-messages';
import { compatReasonTh } from '@/lib/preset-options';

const USER_FACING_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'VALIDATION',
  'INVALID_JSON',
  'TOO_LARGE',
  'UNSUPPORTED_TYPE',
  'UPLOAD_MISSING',
  'UPLOAD_SIZE_MISMATCH',
  'ASSET_NOT_FOUND',
  'ASSET_NOT_READY',
  'ASSET_BUSY',
  'PRESET_UNKNOWN',
  'PRESET_INCOMPATIBLE',
  'PRESET_TOO_SLOW',
  'TOO_MANY_ACTIVE_JOBS',
  'NOT_CANCELLABLE',
  'NOT_REQUEUEABLE',
  'STORAGE_DELETE_FAILED',
  'INTERNAL',
  'SERVER_MISCONFIGURED',
  'NOT_FOUND',
  'INVALID_STATE',
  'INPUT_UNSUPPORTED',
  'INPUT_CORRUPT',
  'GPU_OOM',
  'CANCELLED',
  'OUTPUT_INVALID',
  'ASSET_MISSING',
];

describe('error messages', () => {
  it('has a Thai message for every user-facing code', () => {
    for (const code of USER_FACING_CODES) {
      expect(ERROR_MESSAGES[code], code).toMatch(/[฀-๿]/);
    }
  });

  it('falls back to a generic Thai message with the code', () => {
    expect(errorMessageForCode('SOMETHING_NEW')).toBe('เกิดข้อผิดพลาด (SOMETHING_NEW)');
  });

  it('maps an API error body by code and ignores the English message', () => {
    const body = { error: { code: 'ASSET_BUSY', message: 'A job is running for this asset' } };
    expect(apiErrorText(body, 'x')).toBe(ERROR_MESSAGES.ASSET_BUSY);
    expect(apiErrorText(null, 'สำรอง')).toBe('สำรอง');
    expect(apiErrorText({ error: {} }, 'สำรอง')).toBe('สำรอง');
  });

  it('keeps the worker detail after a Thai prefix for INPUT_UNSUPPORTED', () => {
    expect(jobFailureText('INPUT_UNSUPPORTED', 'width 3840 exceeds 1920')).toBe(
      `${ERROR_MESSAGES.INPUT_UNSUPPORTED}: width 3840 exceeds 1920`,
    );
    expect(jobFailureText('GPU_OOM', 'English detail')).toBe(ERROR_MESSAGES.GPU_OOM);
  });
});

describe('Thai preset compatibility reasons', () => {
  const x4 = getPreset('realesrgan-x4')!;

  it('builds the dimension reason from numbers', () => {
    const r = checkPresetCompatibility(x4, { width: 3840, height: 2160 });
    expect(compatReasonTh(r, x4.label)).toContain('3840×2160');
    expect(compatReasonTh(r, x4.label)).toContain('960×540');
  });

  it('builds the too-slow reason with a suggestion', () => {
    const r = checkPresetCompatibility(x4, { width: 960, height: 540, duration: 120 });
    const text = compatReasonTh(r, x4.label)!;
    expect(text).toMatch(/นาที/);
    expect(text).toContain('Fast 4×');
  });

  it('is null when usable', () => {
    expect(compatReasonTh({ ok: true }, x4.label)).toBeNull();
  });
});

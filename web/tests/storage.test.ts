import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  contentDisposition,
  inputKey,
  outputKey,
  presignGet,
  presignPut,
  sanitizeDownloadFilename,
} from '@/lib/storage';

beforeAll(() => {
  process.env.STORAGE_ENDPOINT = 'https://account.r2.example.test';
  process.env.STORAGE_BUCKET = 'video-enhancer';
  process.env.STORAGE_ACCESS_KEY_ID = 'AKIATEST';
  process.env.STORAGE_SECRET_ACCESS_KEY = 'secret-test';
  delete process.env.STORAGE_REGION;
});

describe('keys', () => {
  it('builds server-side object keys', () => {
    expect(inputKey('a1')).toBe('inputs/a1.mp4');
    expect(outputKey('j1', 'at1')).toBe('outputs/j1/at1.mp4');
  });
});

describe('presigning (offline)', () => {
  it('PUT: path-style URL, expiry and content-type signed, no checksum params', async () => {
    const url = new URL(await presignPut('inputs/a1.mp4', 'video/mp4'));
    expect(url.host).toBe('account.r2.example.test');
    expect(url.pathname).toBe('/video-enhancer/inputs/a1.mp4');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/');
    expect([...url.searchParams.keys()].some((k) => k.toLowerCase().includes('checksum'))).toBe(
      false,
    );
  });

  it('PUT honours a custom expiry', async () => {
    const url = new URL(await presignPut('k', 'video/mp4', 60));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
  });

  it('GET: 1 h default, no content-disposition without a filename', async () => {
    const url = new URL(await presignGet('outputs/j/a.mp4'));
    expect(url.pathname).toBe('/video-enhancer/outputs/j/a.mp4');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(url.searchParams.has('response-content-disposition')).toBe(false);
  });

  it('GET with a filename sets a sanitized content-disposition', async () => {
    const url = new URL(await presignGet('k', 3600, 'my "clip"/..\\x.mp4'));
    const cd = url.searchParams.get('response-content-disposition') ?? '';
    expect(cd.startsWith('attachment; filename="')).toBe(true);
    expect(cd).not.toContain('/');
    expect(cd).not.toContain('\\');
    expect(cd.match(/"/g)).toHaveLength(2);
  });
});

describe('filename sanitizing', () => {
  it('replaces header-unsafe characters and falls back for empty names', () => {
    expect(sanitizeDownloadFilename('a"b/c\r\nd.mp4')).toBe('a_b_c__d.mp4');
    expect(sanitizeDownloadFilename('..')).toBe('video.mp4');
    expect(sanitizeDownloadFilename('   ')).toBe('video.mp4');
  });

  it('encodes non-ASCII names via filename*', () => {
    const cd = contentDisposition('วิดีโอ.mp4');
    expect(cd).toContain('filename="');
    expect(cd).toContain("filename*=UTF-8''%E0%B8%A7");
  });
});

import 'server-only';

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** RustFS (S3-compatible) access. Signed URLs only; bytes never pass through Next.js. */

let client: S3Client | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`${name} is not configured`);
  return value;
}

/** Lazily created so importing this module never reads env (build/prerender safe). */
function getClient(): S3Client {
  client ??= new S3Client({
    endpoint: requireEnv('STORAGE_ENDPOINT'),
    region: process.env.STORAGE_REGION?.trim() || 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: requireEnv('STORAGE_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('STORAGE_SECRET_ACCESS_KEY'),
    },
    // Newer SDKs add CRC32 checksum params to presigned PUTs; clients that do
    // not send them (and S3-compatible servers) would fail signature checks.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

const bucket = () => requireEnv('STORAGE_BUCKET');

export const inputKey = (assetId: string) => `inputs/${assetId}.mp4`;
export const outputKey = (jobId: string, attemptId: string) =>
  `outputs/${jobId}/${attemptId}.mp4`;

export function presignPut(key: string, contentType: string, expiresSec = 900): Promise<string> {
  return getSignedUrl(
    getClient(),
    new PutObjectCommand({ Bucket: bucket(), Key: key, ContentType: contentType }),
    // Sign content-type so the uploader must send exactly this header.
    { expiresIn: expiresSec, signableHeaders: new Set(['content-type']) },
  );
}

/** Keeps the name safe inside a header: no quotes, slashes or control chars. */
export function sanitizeDownloadFilename(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f"\\/:;<>|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'video.mp4';
}

export function contentDisposition(filename: string): string {
  const safe = sanitizeDownloadFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/%/g, '_');
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function presignGet(
  key: string,
  expiresSec = 3600,
  downloadFilename?: string,
): Promise<string> {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: key,
      ...(downloadFilename
        ? { ResponseContentDisposition: contentDisposition(downloadFilename) }
        : {}),
    }),
    { expiresIn: expiresSec },
  );
}

/** Object size, or null when the object does not exist (404/NotFound). */
export async function headObject(key: string): Promise<{ size: number } | null> {
  try {
    const out = await getClient().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return { size: out.ContentLength ?? 0 };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound' || e.name === 'NoSuchKey') {
      return null;
    }
    throw err;
  }
}

export async function deleteObjects(keys: string[]): Promise<void> {
  // DeleteObjects accepts at most 1000 keys per request.
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    const out = await getClient().send(
      new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    if (out.Errors?.length) {
      throw new Error(`Failed to delete ${out.Errors.length} object(s)`);
    }
  }
}

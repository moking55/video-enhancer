/**
 * Object storage smoke test (T2, Cloudflare R2). Run from web/:
 *   npx -y tsx --conditions=react-server --env-file=.env.local scripts/storage-smoke.ts
 * `--conditions=react-server` makes the `server-only` import in lib/storage.ts a no-op.
 * Only touches keys under `spike/`. Never prints secrets or signed URLs.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { deleteObjects, headObject, presignGet, presignPut } from '../lib/storage';

const ORIGIN_OK = 'http://localhost:3000';
const ORIGIN_EVIL = 'https://evil.example';
const SIZE = 1024 * 1024;
const key = `spike/${randomUUID()}.mp4`;
const body = randomBytes(SIZE);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let failed = 0;

async function step(name: string, required: boolean, fn: () => Promise<string>) {
  const t0 = Date.now();
  let ok = false;
  let detail = '';
  try {
    detail = await fn();
    ok = true;
  } catch (e) {
    detail = (e as Error).message;
  }
  const ms = Date.now() - t0;
  if (!ok && required) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${ms}ms] ${name} :: ${detail}`);
}

function expect(cond: boolean, msg: string): string {
  if (!cond) throw new Error(msg);
  return msg;
}

const h = (r: Response, n: string) => r.headers.get(n) ?? '(absent)';
const corsSummary = (r: Response) =>
  `status=${r.status} ACAO=${h(r, 'access-control-allow-origin')} ACAM=${h(r, 'access-control-allow-methods')} ACAH=${h(r, 'access-control-allow-headers')} ACEH=${h(r, 'access-control-expose-headers')} MaxAge=${h(r, 'access-control-max-age')}`;

function preflightOk(r: Response, method: string, header: string): boolean {
  const m = (r.headers.get('access-control-allow-methods') ?? '').toUpperCase();
  const hd = (r.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  const o = r.headers.get('access-control-allow-origin');
  return (
    (r.status === 200 || r.status === 204) &&
    (o === ORIGIN_OK || o === '*') &&
    (m.includes(method) || m === '*') &&
    (hd.includes(header) || hd === '*')
  );
}

async function main() {
  const host = new URL(process.env.STORAGE_ENDPOINT!).host;
  console.log(`endpoint host=${host} bucket=${process.env.STORAGE_BUCKET} key=${key}`);

  try {
    await step('1 presign PUT video/mp4 + upload 1 MiB -> 200', true, async () => {
      const url = await presignPut(key, 'video/mp4');
      const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body });
      console.log(`   Server header: ${h(r, 'server')}; x-amz-request-id: ${h(r, 'x-amz-request-id')}; etag: ${h(r, 'etag')}`);
      return expect(r.status === 200, `status=${r.status}`);
    });

    await step('2 PUT wrong content-type -> expected deny (403)', false, async () => {
      const url = await presignPut(`spike/${randomUUID()}-wrongct.mp4`, 'video/mp4');
      const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: new Uint8Array(16) });
      const t = (await r.text()).slice(0, 120).replace(/\s+/g, ' ');
      if (r.status === 200) throw new Error('NOT DENIED status=200 (content-type not enforced)');
      return expect(r.status === 403, `status=${r.status} body=${t}`);
    });

    await step('3 headObject size matches', true, async () => {
      const head = await headObject(key);
      return expect(head?.size === SIZE, `size=${head?.size}`);
    });

    await step('4a presign GET -> sha256 equal', true, async () => {
      const r = await fetch(await presignGet(key));
      const buf = new Uint8Array(await r.arrayBuffer());
      const match = sha(buf) === sha(body);
      return expect(r.status === 200 && match, `status=${r.status} len=${buf.length} hashMatch=${match} content-type=${h(r, 'content-type')}`);
    });

    await step('4b presign GET with download filename -> Content-Disposition', true, async () => {
      const r = await fetch(await presignGet(key, 3600, 'my video ไทย.mp4'));
      await r.arrayBuffer();
      const cd = r.headers.get('content-disposition');
      return expect(r.status === 200 && !!cd, `status=${r.status} content-disposition=${cd}`);
    });

    await step('5 Range bytes=0-1023 -> 206', true, async () => {
      const r = await fetch(await presignGet(key), { headers: { Range: 'bytes=0-1023' } });
      const buf = new Uint8Array(await r.arrayBuffer());
      return expect(
        r.status === 206 && buf.length === 1024,
        `status=${r.status} len=${buf.length} content-range=${h(r, 'content-range')} accept-ranges=${h(r, 'accept-ranges')}`,
      );
    });

    const putUrl = await presignPut(key, 'video/mp4');
    const getUrl = await presignGet(key);

    await step('6a preflight PUT from allowed origin', true, async () => {
      const r = await fetch(putUrl, {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN_OK, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' },
      });
      return expect(preflightOk(r, 'PUT', 'content-type'), corsSummary(r));
    });

    await step('6b preflight GET + Range header from allowed origin', true, async () => {
      const r = await fetch(getUrl, {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN_OK, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' },
      });
      return expect(preflightOk(r, 'GET', 'range'), corsSummary(r));
    });

    await step('6c preflight evil origin -> expected deny (PUT and GET)', false, async () => {
      const outs: string[] = [];
      let allowed = false;
      const cases: Array<[string, string, string]> = [
        [putUrl, 'PUT', 'content-type'],
        [getUrl, 'GET', 'range'],
      ];
      for (const [url, method, hdrs] of cases) {
        const r = await fetch(url, {
          method: 'OPTIONS',
          headers: { Origin: ORIGIN_EVIL, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': hdrs },
        });
        const o = r.headers.get('access-control-allow-origin');
        if (o === '*' || o === ORIGIN_EVIL) allowed = true;
        outs.push(`${method}: ${corsSummary(r)}`);
      }
      if (allowed) throw new Error(`EVIL ORIGIN ALLOWED :: ${outs.join(' | ')}`);
      return outs.join(' | ');
    });

    await step('6d actual GET carries ACAO / expose headers (allowed origin)', true, async () => {
      const r = await fetch(getUrl, { headers: { Origin: ORIGIN_OK, Range: 'bytes=0-1023' } });
      await r.arrayBuffer();
      const o = r.headers.get('access-control-allow-origin');
      const eh = (r.headers.get('access-control-expose-headers') ?? '').toLowerCase();
      const s = `status=${r.status} ACAO=${o ?? '(absent)'} ACEH=${eh || '(absent)'} content-range=${h(r, 'content-range')} accept-ranges=${h(r, 'accept-ranges')}`;
      return expect(o === ORIGIN_OK || o === '*', s);
    });

    await step('6e actual GET from evil origin: no ACAO (informational)', false, async () => {
      const r = await fetch(getUrl, { headers: { Origin: ORIGIN_EVIL } });
      await r.arrayBuffer();
      const o = r.headers.get('access-control-allow-origin');
      return expect(o !== '*' && o !== ORIGIN_EVIL, `status=${r.status} ACAO=${o ?? '(absent)'}`);
    });

    await step('7 expired URL (1s expiry, wait 3s) -> 403', true, async () => {
      const url = await presignGet(key, 1);
      await new Promise((res) => setTimeout(res, 3000));
      const r = await fetch(url);
      await r.arrayBuffer();
      return expect(r.status === 403, `status=${r.status}`);
    });
  } finally {
    await step('8 cleanup: delete spike/ objects; HEAD -> null', true, async () => {
      // Listing is not exported by storage.ts; equivalent client, same options.
      const s3 = new S3Client({
        endpoint: process.env.STORAGE_ENDPOINT!,
        region: process.env.STORAGE_REGION?.trim() || 'auto',
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.STORAGE_ACCESS_KEY_ID!,
          secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY!,
        },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
      const bucket = process.env.STORAGE_BUCKET!;
      const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'spike/' }));
      const keys = (list.Contents ?? []).map((o) => o.Key!).filter((k) => k.startsWith('spike/'));
      if (keys.length) await deleteObjects(keys);
      const head = await headObject(key);
      const left = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'spike/' }));
      return expect(
        head === null && (left.KeyCount ?? 0) === 0,
        `deleted=${keys.length} head=${head === null ? 'null' : 'EXISTS'} remaining=${left.KeyCount ?? 0}`,
      );
    });
  }

  console.log(`\n${failed === 0 ? 'ALL REQUIRED STEPS PASSED' : `${failed} REQUIRED STEP(S) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('fatal:', (e as Error).message);
  process.exit(2);
});

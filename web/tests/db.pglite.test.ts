// Runs the real migration file against an in-process Postgres (PGlite) with a
// minimal stub of the Supabase pieces it depends on (roles, auth schema).
// No Docker, no network. Concurrency (SKIP LOCKED across connections) is NOT
// covered here; see db.integration.test.ts (opt-in via TEST_DATABASE_URL).
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(import.meta.dirname, '../../supabase/migrations');

const STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
  $$;
  -- mirrors Supabase defaults: new public objects are granted to the API roles
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

describe('db (PGlite): migration, RLS, claim_job', () => {
  let db: PGlite;
  const userA = randomUUID();
  const userB = randomUUID();
  const assetA = randomUUID();

  type Row = Record<string, unknown>;

  async function insertJob(owner: string, preset: string, createdAt: string) {
    const id = randomUUID();
    await db.query(
      `insert into public.jobs (id, owner_id, asset_id, preset_id, created_at)
       values ($1, $2, $3, $4, $5)`,
      [id, owner, assetA, preset, createdAt],
    );
    return id;
  }

  /** Rows returned by claim_job: [] when nothing is claimable, [job] when claimed. */
  async function claim(presets: string[]): Promise<Row[]> {
    const r = await db.query<Row>('select * from public.claim_job($1)', [presets]);
    return r.rows;
  }

  /** claim_job expected to claim exactly one job. */
  async function claimOne(presets: string[]): Promise<Row> {
    const rows = await claim(presets);
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  /** Run fn as a role (+ optional JWT sub), inside a transaction that is rolled back. */
  async function asRole<T>(role: string, sub: string | null, fn: () => Promise<T>): Promise<T> {
    await db.exec('begin');
    try {
      await db.exec(`set local role ${role}`);
      if (sub) {
        await db.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub, role }),
        ]);
      }
      return await fn();
    } finally {
      await db.exec('rollback');
    }
  }

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(STUB);
    for (const f of readdirSync(migrationsDir).filter((n) => n.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(path.join(migrationsDir, f), 'utf8'));
    }
    await db.query('insert into auth.users (id) values ($1), ($2)', [userA, userB]);
    await db.query(
      `insert into public.assets (id, owner_id, object_key, filename, size_bytes)
       values ($1, $2, $3, 'a.mp4', 1)`,
      [assetA, userA, `inputs/${assetA}.mp4`],
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  it('enforces state check constraints and defaults', async () => {
    await expect(
      db.query(
        `insert into public.jobs (owner_id, asset_id, preset_id, state) values ($1, $2, 'p', 'BOGUS')`,
        [userA, assetA],
      ),
    ).rejects.toThrow();
    const id = await insertJob(userA, 'realesrgan-x2', '2026-01-01T00:00:00Z');
    const r = await db.query<Row>('select state, attempt_count, cancel_requested from public.jobs where id = $1', [id]);
    expect(r.rows[0]).toMatchObject({ state: 'QUEUED', attempt_count: 0, cancel_requested: false });
    await db.query('delete from public.jobs');
  });

  it('anon cannot select jobs and cannot execute claim_job', async () => {
    await insertJob(userA, 'realesrgan-x2', '2026-01-01T00:00:00Z');
    await asRole('anon', null, async () => {
      await expect(db.query('select id from public.jobs')).rejects.toMatchObject({ code: '42501' });
    });
    await asRole('anon', null, async () => {
      await expect(claim(['realesrgan-x2'])).rejects.toMatchObject({ code: '42501' });
    });
    await db.query('delete from public.jobs');
  });

  it('authenticated cannot execute claim_job', async () => {
    await insertJob(userA, 'realesrgan-x2', '2026-01-01T00:00:00Z');
    await asRole('authenticated', userA, async () => {
      await expect(claim(['realesrgan-x2'])).rejects.toMatchObject({ code: '42501' });
    });
    const r = await db.query<Row>('select state from public.jobs');
    expect(r.rows.every((x) => x.state === 'QUEUED')).toBe(true);
    await db.query('delete from public.jobs');
  });

  it('service_role can execute claim_job', async () => {
    await insertJob(userA, 'realesrgan-x2', '2026-01-01T00:00:00Z');
    await asRole('service_role', null, async () => {
      expect((await claimOne(['realesrgan-x2'])).state).toBe('RUNNING');
    });
    await db.query('delete from public.jobs');
  });

  it('RLS: authenticated sees only own rows and cannot write others', async () => {
    await insertJob(userA, 'realesrgan-x2', '2026-01-01T00:00:00Z');

    await asRole('authenticated', userB, async () => {
      expect((await db.query('select id from public.jobs')).rows).toHaveLength(0);
      expect((await db.query('select id from public.assets')).rows).toHaveLength(0);
      const upd = await db.query('update public.jobs set cancel_requested = true');
      expect(upd.affectedRows).toBe(0);
      const del = await db.query('delete from public.jobs');
      expect(del.affectedRows).toBe(0);
    });
    await asRole('authenticated', userB, async () => {
      await expect(
        db.query(`insert into public.jobs (owner_id, asset_id, preset_id) values ($1, $2, 'x')`, [
          userA,
          assetA,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    });
    await asRole('authenticated', userA, async () => {
      expect((await db.query('select id from public.jobs')).rows).toHaveLength(1);
      const upd = await db.query('update public.jobs set cancel_requested = true');
      expect(upd.affectedRows).toBe(1);
    });
    await db.query('delete from public.jobs');
  });

  it('RLS: worker_tokens are owner-only and have no delete policy', async () => {
    await db.query(`insert into public.worker_tokens (owner_id, token_sha256) values ($1, 'h1')`, [userA]);
    await asRole('authenticated', userB, async () => {
      expect((await db.query('select id from public.worker_tokens')).rows).toHaveLength(0);
    });
    await asRole('authenticated', userA, async () => {
      expect((await db.query('select id from public.worker_tokens')).rows).toHaveLength(1);
      expect((await db.query('delete from public.worker_tokens')).affectedRows).toBe(0);
    });
    await expect(
      db.query(`insert into public.worker_tokens (owner_id, token_sha256) values ($1, 'h1')`, [userA]),
    ).rejects.toThrow(); // unique token_sha256
    await db.query('delete from public.worker_tokens');
  });

  it('claim_job: oldest matching QUEUED across owners, sets RUNNING/attempt, then zero rows when empty', async () => {
    const x4 = await insertJob(userA, 'realesrgan-x4', '2026-01-01T00:00:00Z');
    const x2New = await insertJob(userA, 'realesrgan-x2', '2026-01-03T00:00:00Z');
    const x2Old = await insertJob(userA, 'realesrgan-x2', '2026-01-02T00:00:00Z');
    const other = await insertJob(userB, 'realesrgan-x2', '2026-01-02T12:00:00Z');

    expect(await claim(['seedvr2-x'])).toHaveLength(0);
    expect(await claim([])).toHaveLength(0);

    const first = await claimOne(['realesrgan-x2']);
    expect(first.id).toBe(x2Old); // oldest matching, though x4 is older overall
    expect(first.state).toBe('RUNNING');
    expect(first.attempt_count).toBe(1);
    expect(first.attempt_id).toBeTruthy();
    expect(first.started_at).toBeTruthy();
    expect(first.heartbeat_at).toBeTruthy();

    // FIFO crosses owners: B's job (between A's two) is claimed before A's newer one.
    const second = await claimOne(['realesrgan-x2']);
    expect(second.id).toBe(other);
    expect(second.owner_id).toBe(userB);
    expect((await claimOne(['realesrgan-x2'])).id).toBe(x2New);
    expect(await claim(['realesrgan-x2'])).toHaveLength(0);
    expect((await claimOne(['realesrgan-x2', 'realesrgan-x4'])).id).toBe(x4);
    expect(await claim(['realesrgan-x2', 'realesrgan-x4'])).toHaveLength(0);

    // Requeue then claim: new attempt, count 2, started_at kept, progress/error cleared.
    await db.query(
      `update public.jobs set state = 'QUEUED', stage = 'x', processed_frames = 5,
              total_frames = 9, error_code = 'E', error_message = 'm' where id = $1`,
      [x2Old],
    );
    const again = await claimOne(['realesrgan-x2']);
    expect(again.id).toBe(x2Old);
    expect(again.attempt_count).toBe(2);
    expect(again.attempt_id).not.toBe(first.attempt_id);
    expect(again.started_at).toEqual(first.started_at);
    expect(again.stage).toBeNull();
    expect(again.processed_frames).toBeNull();
    expect(again.total_frames).toBeNull();
    expect(again.error_code).toBeNull();
    expect(again.error_message).toBeNull();
  });

  it('claim_job: filters by preset across owners; empty queue -> 0 rows', async () => {
    await db.query('delete from public.jobs');
    expect(await claim(['realesrgan-x2'])).toHaveLength(0);
    const a = await insertJob(userA, 'realesrgan-x4', '2026-02-01T00:00:00Z');
    const b = await insertJob(userB, 'realesrgan-x2', '2026-02-02T00:00:00Z');
    expect((await claimOne(['realesrgan-x2'])).id).toBe(b);
    expect(await claim(['realesrgan-x2'])).toHaveLength(0);
    expect((await claimOne(['realesrgan-x4'])).id).toBe(a);
    // RUNNING jobs are never re-claimed.
    expect(await claim(['realesrgan-x2', 'realesrgan-x4'])).toHaveLength(0);
    await db.query('delete from public.jobs');
  });
});

// Integration tests for supabase/migrations (RLS + claim_job).
// Runs only when TEST_DATABASE_URL points at a LOCAL Supabase Postgres, e.g.
//   postgresql://postgres:postgres@127.0.0.1:54322/postgres
// It connects as the superuser and creates/deletes its own auth.users rows.
import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

d('db: RLS + claim_job', () => {
  let admin: Client;
  const userA = randomUUID();
  const userB = randomUUID();
  const assetA = randomUUID();

  async function insertJob(owner: string, presetId: string, createdAt: string) {
    const id = randomUUID();
    await admin.query(
      `insert into public.jobs (id, owner_id, asset_id, preset_id, created_at)
       values ($1, $2, $3, $4, $5)`,
      [id, owner, assetA, presetId, createdAt],
    );
    return id;
  }

  async function resetJobs() {
    await admin.query(`delete from public.jobs where owner_id in ($1, $2)`, [userA, userB]);
  }

  /** Run `fn` in a transaction as the given role / JWT subject; always rolls back. */
  async function asRole<T>(
    role: 'anon' | 'authenticated',
    sub: string | null,
    fn: (c: Client) => Promise<T>,
  ): Promise<T> {
    const c = await connect();
    try {
      await c.query('begin');
      await c.query(`set local role ${role}`);
      if (sub) {
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub, role }),
        ]);
      }
      return await fn(c);
    } finally {
      await c.query('rollback').catch(() => {});
      await c.end();
    }
  }

  beforeAll(async () => {
    admin = await connect();
    for (const id of [userA, userB]) {
      await admin.query(
        `insert into auth.users (id, email, aud, role)
         values ($1, $2, 'authenticated', 'authenticated')`,
        [id, `${id}@test.invalid`],
      );
    }
    await admin.query(
      `insert into public.assets (id, owner_id, object_key, filename, size_bytes)
       values ($1, $2, $3, 'a.mp4', 1)`,
      [assetA, userA, `inputs/${assetA}.mp4`],
    );
  });

  afterAll(async () => {
    if (!admin) return;
    // cascades to assets, jobs, worker_tokens
    await admin.query(`delete from auth.users where id in ($1, $2)`, [userA, userB]);
    await admin.end();
  });

  it('anon cannot read jobs', async () => {
    await resetJobs();
    await insertJob(userA, 'realesrgan-x2', '2026-01-01T00:00:00Z');
    await asRole('anon', null, async (c) => {
      // Either a permission error or zero rows is acceptable; visible rows are not.
      let rowCount = 0;
      let code: string | undefined;
      try {
        rowCount = (await c.query('select id from public.jobs')).rows.length;
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(rowCount).toBe(0);
      if (code !== undefined) expect(code).toBe('42501');
    });
  });

  it('anon and authenticated cannot execute claim_job', async () => {
    await resetJobs();
    const id = await insertJob(userA, 'realesrgan-x2', '2026-01-01T00:00:00Z');
    for (const [role, sub] of [
      ['anon', null],
      ['authenticated', userA],
    ] as const) {
      await asRole(role, sub, async (c) => {
        await expect(
          c.query('select * from public.claim_job($1)', [['realesrgan-x2']]),
        ).rejects.toMatchObject({ code: '42501' });
      });
    }
    const { rows } = await admin.query('select state from public.jobs where id = $1', [id]);
    expect(rows[0].state).toBe('QUEUED');
  });

  it('authenticated sees only own rows (RLS)', async () => {
    await resetJobs();
    await insertJob(userA, 'realesrgan-x2', '2026-01-01T00:00:00Z');

    await asRole('authenticated', userB, async (c) => {
      expect((await c.query('select id from public.jobs')).rows).toHaveLength(0);
      expect((await c.query('select id from public.assets')).rows).toHaveLength(0);
      // Cannot insert a row owned by someone else, nor touch A's rows.
      await expect(
        c.query(
          `insert into public.jobs (owner_id, asset_id, preset_id) values ($1, $2, 'x')`,
          [userA, assetA],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
    await asRole('authenticated', userB, async (c) => {
      const upd = await c.query(
        `update public.jobs set cancel_requested = true where owner_id = $1`,
        [userA],
      );
      expect(upd.rowCount).toBe(0);
    });

    await asRole('authenticated', userA, async (c) => {
      expect((await c.query('select id from public.jobs')).rows).toHaveLength(1);
    });
  });

  it('claim_job: two concurrent callers, one QUEUED job -> exactly one wins', async () => {
    await resetJobs();
    const id = await insertJob(userA, 'realesrgan-x2', '2026-01-01T00:00:00Z');
    const [c1, c2] = await Promise.all([connect(), connect()]);
    try {
      // Deterministic overlap: c1 holds the row lock in an open transaction
      // while c2 calls claim_job; SKIP LOCKED must make c2 see nothing.
      await c1.query('begin');
      const r1 = await c1.query('select * from public.claim_job($1)', [
        ['realesrgan-x2'],
      ]);
      const r2 = await c2.query('select * from public.claim_job($1)', [
        ['realesrgan-x2'],
      ]);
      await c1.query('commit');

      expect(r1.rows).toHaveLength(1);
      expect(r1.rows[0].id).toBe(id);
      expect(r1.rows[0].state).toBe('RUNNING');
      expect(r1.rows[0].attempt_count).toBe(1);
      expect(r1.rows[0].attempt_id).toBeTruthy();
      expect(r1.rows[0].started_at).toBeTruthy();
      expect(r1.rows[0].heartbeat_at).toBeTruthy();
      expect(r2.rows).toHaveLength(0);
    } finally {
      await c1.query('rollback').catch(() => {});
      await Promise.all([c1.end(), c2.end()]);
    }
  });

  it('claim_job: racing without explicit transactions still yields one winner', async () => {
    await resetJobs();
    await insertJob(userA, 'realesrgan-x2', '2026-01-01T00:00:00Z');
    const clients = await Promise.all([connect(), connect(), connect(), connect()]);
    try {
      const results = await Promise.all(
        clients.map((c) =>
          c.query('select * from public.claim_job($1)', [['realesrgan-x2']]),
        ),
      );
      const winners = results.filter((r) => r.rows.length === 1);
      expect(winners).toHaveLength(1);
      expect(winners[0].rows[0].state).toBe('RUNNING');
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it('claim_job: respects p_presets and FIFO order across owners; requeue gets a new attempt', async () => {
    await resetJobs();
    const x4 = await insertJob(userA, 'realesrgan-x4', '2026-01-01T00:00:00Z');
    const x2New = await insertJob(userA, 'realesrgan-x2', '2026-01-03T00:00:00Z');
    const x2Old = await insertJob(userA, 'realesrgan-x2', '2026-01-02T00:00:00Z');
    const other = await insertJob(userB, 'realesrgan-x2', '2026-01-02T12:00:00Z');

    /** Rows returned by claim_job: [] when nothing is claimable, [job] when claimed. */
    const claim = async (presets: string[]) =>
      (await admin.query('select * from public.claim_job($1)', [presets])).rows;
    const claimOne = async (presets: string[]) => {
      const rows = await claim(presets);
      expect(rows).toHaveLength(1);
      return rows[0];
    };

    expect(await claim(['seedvr2-x'])).toHaveLength(0);
    expect(await claim([])).toHaveLength(0);

    const first = await claimOne(['realesrgan-x2']);
    expect(first.id).toBe(x2Old); // oldest matching, even though x4 is older overall
    // FIFO crosses owners: B's job sits between A's two.
    expect((await claimOne(['realesrgan-x2'])).id).toBe(other);
    expect((await claimOne(['realesrgan-x2'])).id).toBe(x2New);
    expect(await claim(['realesrgan-x2'])).toHaveLength(0);

    const last = await claimOne(['realesrgan-x2', 'realesrgan-x4']);
    expect(last.id).toBe(x4);

    // Requeue -> claim again: new attempt id, count 2, started_at kept, progress cleared.
    await admin.query(
      `update public.jobs set state = 'QUEUED', stage = 'x', processed_frames = 5,
              error_code = 'E', error_message = 'm' where id = $1`,
      [x2Old],
    );
    const again = await claimOne(['realesrgan-x2']);
    expect(again.id).toBe(x2Old);
    expect(again.attempt_count).toBe(2);
    expect(again.attempt_id).not.toBe(first.attempt_id);
    expect(again.started_at).toEqual(first.started_at);
    expect(again.stage).toBeNull();
    expect(again.processed_frames).toBeNull();
    expect(again.error_code).toBeNull();
  });
});

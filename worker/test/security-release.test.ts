import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { api, registerUser, testDb, insertAccount } from "./helpers";
import { createApp } from "../src/app";
import { encrypt, sha256Hex } from "../src/lib/crypto";
import { signToken } from "../src/lib/session";
import {
  enqueueForCron,
  enqueueJob,
  makeJobContext,
  runJobs,
  dispatchJobs,
} from "../src/lib/jobs";

beforeEach(async () => {
  await testDb().run("DELETE FROM jobs");
  await testDb().run("DELETE FROM cron_sweeps");
  await testDb().run("DELETE FROM accounts");
});
it("1000 connected accounts all receive hourly and daily jobs through durable pages", async () => {
  const u = await registerUser(),
    db = testDb(),
    now = new Date("2026-09-07T18:00:00Z");
  for (let i = 0; i < 1000; i++)
    await db.run(
      `INSERT INTO accounts(id,user_id,threads_user_id,username,color,token_enc,token_obtained_at,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      `capacity-${String(i).padStart(4, "0")}`,
      u.userId,
      String(i),
      "test",
      "#000",
      "unread-test-token",
      now.toISOString(),
      now.toISOString(),
    );
  await enqueueForCron(makeJobContext(env, { now }), "0 * * * *");
  await enqueueForCron(makeJobContext(env, { now }), "0 18 * * *");
  for (let i = 0; i < 7; i++)
    await enqueueForCron(makeJobContext(env, { now }), "* * * * *");
  expect(
    (
      await db.first<{ n: number }>(
        "SELECT COUNT(*) n FROM cron_sweeps WHERE done=0",
      )
    )?.n,
  ).toBe(0);
  expect(
    (
      await db.first<{ n: number }>(
        "SELECT COUNT(*) n FROM jobs WHERE account_id IS NOT NULL",
      )
    )?.n,
  ).toBe(9000);
  expect(
    (
      await db.first<{ n: number }>(
        "SELECT COUNT(*) n FROM jobs WHERE account_id='capacity-0999'",
      )
    )?.n,
  ).toBe(9);
  const before = (await db.first<{ n: number }>("SELECT COUNT(*) n FROM jobs"))!
    .n;
  await db.run("UPDATE jobs SET status='done'");
  await enqueueForCron(makeJobContext(env, { now }), "0 * * * *");
  expect(
    (await db.first<{ n: number }>("SELECT COUNT(*) n FROM jobs"))!.n,
  ).toBe(before);
});
it("concurrent enqueue is atomic and queue redelivery cannot execute a completed job again", async () => {
  const u = await registerUser(),
    accountId = await insertAccount({ userId: u.userId });
  const ids = await Promise.all(
    Array.from({ length: 8 }, () =>
      enqueueJob(makeJobContext(env), "clicks", { accountId }),
    ),
  );
  expect(ids.filter(Boolean)).toHaveLength(1);
  let calls = 0;
  const handlers = {
    clicks: async () => {
      calls++;
    },
  };
  await runJobs(makeJobContext(env), handlers, ids.find(Boolean)!);
  await runJobs(makeJobContext(env), handlers, ids.find(Boolean)!);
  expect(calls).toBe(1);
});
it("queue dispatch leases prevent repeated dispatch and respect D1 binding limits", async () => {
  const ctx = makeJobContext(env);
  for (let i = 0; i < 1005; i++)
    await enqueueJob(makeJobContext(env, {now:ctx.now}), "cleanup", { force: true });
  const messages: unknown[][] = [];
  ctx.env = {
    ...env,
    JOB_QUEUE: {
      sendBatch: async (items: unknown[]) => {
        messages.push(items);
      },
    } as unknown as Queue<{ jobId: string }>,
  };
  await dispatchJobs(ctx);
  expect(messages).toHaveLength(10);
  expect(messages.every((batch) => batch.length === 98)).toBe(true);
  await dispatchJobs(makeJobContext(ctx.env));
  expect(messages[10]).toHaveLength(25);
  await dispatchJobs(makeJobContext(ctx.env));
  expect(messages).toHaveLength(11);
});
it("logout removes only the current device push registration; AI deletion clears server key", async () => {
  const a = await registerUser(),
    db = testDb();
  await db.run(
    "INSERT INTO push_subscriptions(id,user_id,json,created_at,session_id) VALUES (?,?,?,?,?)",
    "own",
    a.userId,
    await encrypt("{}", env.ENC_KEY),
    new Date().toISOString(),
    await sha256Hex(a.cookie.slice(4)),
  );
  await db.run(
    "INSERT INTO push_subscriptions(id,user_id,json,created_at,session_id) VALUES (?,?,?,?,?)",
    "other",
    a.userId,
    "dummy",
    new Date().toISOString(),
    "other-session",
  );
  expect(
    (
      await api("PUT", "/api/ai/settings", {
        cookie: a.cookie,
        body: { provider: "gemini", key: "test-only-key", storeOnServer: true },
      })
    ).status,
  ).toBe(200);
  expect(
    (await api("DELETE", "/api/ai/settings/key", { cookie: a.cookie })).status,
  ).toBe(200);
  expect(
    (await api("GET", "/api/ai/settings", { cookie: a.cookie })).body.data
      .hasKey,
  ).toBe(false);
  expect(
    (await api("POST", "/api/auth/logout", { cookie: a.cookie })).status,
  ).toBe(200);
  expect(
    await db.first("SELECT id FROM push_subscriptions WHERE id='own'"),
  ).toBeNull();
  expect(
    await db.first("SELECT id FROM push_subscriptions WHERE id='other'"),
  ).not.toBeNull();
});
it("a raced reset rejected with 400 never changes the accepted password", async () => {
  const u = await registerUser(),
    db = testDb(),
    id = crypto.randomUUID(),
    expires = Math.floor(Date.now() / 1000) + 1800;
  const token = await signToken(env.SESSION_SECRET, {
    purpose: "pwreset",
    sub: id,
    extra: "",
    expires,
  });
  await db.run(
    "INSERT INTO password_resets(id,user_id,token_hash,expires_at,used_at,created_at) VALUES (?,?,?,?,NULL,?)",
    id,
    u.userId,
    await sha256Hex(token),
    new Date(expires * 1000).toISOString(),
    new Date().toISOString(),
  );
  let signal!: () => void, release!: () => void;
  const read = new Promise<void>((r) => {
      signal = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const delayed = new Proxy(env.DB, {
    get(target, p) {
      if (p === "prepare")
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (
            !sql.includes("FROM password_resets WHERE id=?") ||
            !sql.startsWith("SELECT id,")
          )
            return stmt;
          const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(s, {
              get(t, k) {
                if (k === "bind")
                  return (...args: unknown[]) => wrap(t.bind(...args));
                if (k === "first")
                  return async () => {
                    const row = await t.first();
                    signal();
                    await gate;
                    return row;
                  };
                const v = Reflect.get(t, k, t);
                return typeof v === "function" ? v.bind(t) : v;
              },
            });
          return wrap(stmt);
        };
      const v = Reflect.get(target, p, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const pending = createApp().fetch(
    new Request("https://test.local/api/auth/reset", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "fetch",
      },
      body: JSON.stringify({ token, password: "rejected-password" }),
    }),
    { ...env, DB: delayed },
  );
  await read;
  const accepted = await api("POST", "/api/auth/reset", {
    body: { token, password: "accepted-password" },
  });
  release();
  expect(accepted.status).toBe(200);
  expect((await pending).status).toBe(400);
  expect(
    (
      await api("POST", "/api/auth/login", {
        body: { email: u.email, password: "accepted-password" },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api("POST", "/api/auth/login", {
        body: { email: u.email, password: "rejected-password" },
      })
    ).status,
  ).toBe(401);
});
it("source quota rejects excess inserts without changing other users data", async () => {
  const a = await registerUser(),
    b = await registerUser(),
    db = testDb();
  for (let i = 0; i < 200; i++)
    await db.run(
      "INSERT INTO sources(id,user_id,type,title,content,created_at) VALUES (?,?,'text','test','test',?)",
      crypto.randomUUID(),
      a.userId,
      new Date().toISOString(),
    );
  expect(
    (
      await api("POST", "/api/sources", {
        cookie: a.cookie,
        body: { type: "text", content: "excess" },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await api("POST", "/api/sources", {
        cookie: b.cookie,
        body: { type: "text", content: "allowed" },
      })
    ).status,
  ).toBe(201);
});

it("maintenance stops API writes before user data changes", async () => {
  const a = await registerUser();
  const request = new Request("https://test.local/api/sources", {
    method: "POST",
    headers: {
      Cookie: a.cookie,
      "Content-Type": "application/json",
      "X-Requested-With": "fetch",
    },
    body: JSON.stringify({ type: "text", content: "blocked" }),
  });
  expect(
    (await createApp().fetch(request, { ...env, MAINTENANCE_MODE: "1" }))
      .status,
  ).toBe(503);
  expect(
    await testDb().first("SELECT id FROM sources WHERE user_id=?", a.userId),
  ).toBeNull();
});

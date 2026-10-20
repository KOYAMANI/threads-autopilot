import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, insertAccount, mockToken, registerUser, testDb } from "./helpers";
import { ACCOUNT_CHILD_TABLES } from "../src/lib/accounts";
import { enqueueJob, makeJobContext, runJobs } from "../src/lib/jobs";
import { SYNC_TOTAL_PAGES } from "../src/jobs/sync";
import { resetMock } from "../src/mock/threads";
import { decrypt } from "../src/lib/crypto";

const NOW = new Date("2026-09-06T00:00:00.000Z");

beforeEach(() => {
  resetMock();
});

describe("POST /api/accounts（SPEC §7.1）", () => {
  it("モックトークンで接続でき、full_sync が投入される", async () => {
    const u = await registerUser();
    const res = await api("POST", "/api/accounts", {
      cookie: u.cookie,
      body: { token: mockToken("conn1") },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.account.username).toMatch(/^demo_/);
    expect(res.body.data.longLived).toBe(true);
    expect(res.body.data.secretIgnored).toBe(false);

    const accountId = res.body.data.account.id as string;
    const job = await testDb().first<{ type: string; status: string }>(
      "SELECT type, status FROM jobs WHERE account_id=? AND type='full_sync'",
      accountId,
    );
    expect(job?.status).toBe("pending");

    // autopilot の行も作られる
    const ap = await testDb().first<{ enabled: number }>(
      "SELECT enabled FROM autopilot WHERE account_id=?",
      accountId,
    );
    expect(ap?.enabled).toBe(0);

    // トークンは暗号化して保存される（平文で残らない）
    const row = await testDb().first<{ token_enc: string }>(
      "SELECT token_enc FROM accounts WHERE id=?",
      accountId,
    );
    expect(row!.token_enc).not.toContain("THAAdemo");
    expect(await decrypt(row!.token_enc, env.ENC_KEY)).toBe(mockToken("conn1"));
  });

  it("app_secret を渡すと長期トークンになる（App Secret は保存しない）", async () => {
    const u = await registerUser();
    const res = await api("POST", "/api/accounts", {
      cookie: u.cookie,
      body: { token: mockToken("conn2"), app_secret: "secret-value" },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.longLived).toBe(true);
    expect(res.body.data.account.tokenExpiresInDays).toBe(60);

    const row = await testDb().first<{ token_enc: string }>(
      "SELECT token_enc FROM accounts WHERE id=?",
      res.body.data.account.id,
    );
    const stored = await decrypt(row!.token_enc, env.ENC_KEY);
    expect(stored).toBe(`${mockToken("conn2")}_long`);
    expect(JSON.stringify(res.body)).not.toContain("secret-value");
  });

  it("無料プランは1件まで（2件目は ACCOUNT_LIMIT）", async () => {
    const u = await registerUser();
    const first = await api("POST", "/api/accounts", {
      cookie: u.cookie,
      body: { token: mockToken("limit0") },
    });
    expect(first.status).toBe(201);
    const over = await api("POST", "/api/accounts", {
      cookie: u.cookie,
      body: { token: mockToken("limit1") },
    });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe("ACCOUNT_LIMIT");
    expect(over.body.error.message).toContain("1つまで");
  });

  it("講座生プランは3件まで（4件目は ACCOUNT_LIMIT）", async () => {
    const u = await registerUser();
    await testDb().run("UPDATE user_entitlements SET plan_code='academy', account_limit=3 WHERE user_id=?", u.userId);
    for (let i = 0; i < 3; i++) {
      const res = await api("POST", "/api/accounts", {
        cookie: u.cookie,
        body: { token: mockToken(`academy-limit${i}`) },
      });
      expect(res.status).toBe(201);
    }
    const over = await api("POST", "/api/accounts", {
      cookie: u.cookie,
      body: { token: mockToken("academy-limit3") },
    });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe("ACCOUNT_LIMIT");
    expect(over.body.error.message).toContain("3つまで");
  });

  it("管理者は無料プランのままでも10件まで接続でき、上限到達後も再接続できる", async () => {
    const u = await registerUser();
    const previous = env.ADMIN_USER_ID;
    env.ADMIN_USER_ID = u.userId;
    try {
      const me = await api("GET", "/api/auth/me", { cookie: u.cookie });
      expect(me.body.data.isAdmin).toBe(true);
      expect(me.body.data.entitlement.accountLimit).toBe(10);

      for (let i = 0; i < 10; i++) {
        const res = await api("POST", "/api/accounts", {
          cookie: u.cookie,
          body: { token: mockToken(`admin-limit${i}`) },
        });
        expect(res.status).toBe(201);
      }
      const over = await api("POST", "/api/accounts", {
        cookie: u.cookie,
        body: { token: mockToken("admin-limit10") },
      });
      expect(over.status).toBe(400);
      expect(over.body.error.code).toBe("ACCOUNT_LIMIT");
      expect(over.body.error.message).toContain("10つまで");
      const reconnect = await api("POST", "/api/accounts", {
        cookie: u.cookie,
        body: { token: mockToken("admin-limit0") },
      });
      expect(reconnect.status).toBe(200);
      const updated = await api("GET", "/api/auth/me", { cookie: u.cookie });
      expect(updated.body.data.accounts).toHaveLength(10);
    } finally {
      // This test creates 40 sync jobs; keep them out of later scheduler tests.
      await testDb().run("DELETE FROM jobs WHERE account_id IN (SELECT id FROM accounts WHERE user_id=?)", u.userId);
      env.ADMIN_USER_ID = previous;
    }
  });

  it("同じ Threads アカウントの再接続は上限に数えず、つなぎ直しになる", async () => {
    const u = await registerUser();
    const first = await api("POST", "/api/accounts", {
      cookie: u.cookie,
      body: { token: mockToken("again") },
    });
    const accountId = first.body.data.account.id as string;
    await testDb().run("UPDATE accounts SET status='needs_reauth' WHERE id=?", accountId);

    const again = await api("POST", "/api/accounts", {
      cookie: u.cookie,
      body: { token: mockToken("again") },
    });
    expect(again.status).toBe(200);
    expect(again.body.data.account.id).toBe(accountId);
    expect(again.body.data.account.status).toBe("ok");
  });

  it("他人のアカウントは触れない（アカウントIDを取るルート全部）", async () => {
    const owner = await registerUser();
    const other = await registerUser();
    const res = await api("POST", "/api/accounts", {
      cookie: owner.cookie,
      body: { token: mockToken("owned") },
    });
    const accountId = res.body.data.account.id as string;

    // 本人の側でリンクと投稿を1件ずつ作り、子リソースのIDも他人から叩けないことを見る
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "full_sync", { accountId, force: true });
    await runJobs(ctx);
    const links = await api("GET", `/api/accounts/${accountId}/links`, { cookie: owner.cookie });
    const linkId = links.body.data.links[0].id as string;
    const posts = await api("GET", `/api/accounts/${accountId}/posts`, { cookie: owner.cookie });
    const postId = posts.body.data.posts[0].id as string;

    const routes: Array<[string, string, unknown?]> = [
      ["GET", `/api/accounts/${accountId}/dashboard`],
      ["GET", `/api/accounts/${accountId}/diagnose`],
      ["GET", `/api/accounts/${accountId}/sync`],
      ["POST", `/api/accounts/${accountId}/sync`, {}],
      ["POST", `/api/accounts/${accountId}/refresh-token`, {}],
      ["PATCH", `/api/accounts/${accountId}`, { color: "#123456" }],
      ["GET", `/api/accounts/${accountId}/posts`],
      ["GET", `/api/accounts/${accountId}/posts/${postId}`],
      ["POST", `/api/accounts/${accountId}/posts/${postId}/repost`, {}],
      ["GET", `/api/accounts/${accountId}/links`],
      ["POST", `/api/accounts/${accountId}/links`, { url: "https://x.example", label: "x" }],
      ["PATCH", `/api/accounts/${accountId}/links/${linkId}`, { label: "x" }],
      ["DELETE", `/api/accounts/${accountId}/links/${linkId}`],
      ["DELETE", `/api/accounts/${accountId}`],
    ];

    for (const [method, path, body] of routes) {
      const r = await api(method, path, {
        cookie: other.cookie,
        ...(body === undefined ? {} : { body }),
      });
      expect({ method, path, status: r.status }).toEqual({ method, path, status: 404 });
    }

    // 本人のアカウントは消えていない
    const still = await testDb().first("SELECT id FROM accounts WHERE id=?", accountId);
    expect(still).not.toBeNull();
  });

  it("接続応答にも一覧にも復号したトークンは出ない（SPEC §5.2）", async () => {
    const u = await registerUser();
    const token = mockToken("leak1");
    const res = await api("POST", "/api/accounts", { cookie: u.cookie, body: { token } });
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(JSON.stringify(res.body)).not.toContain("token_enc");

    const list = await api("GET", "/api/accounts", { cookie: u.cookie });
    expect(JSON.stringify(list.body)).not.toContain(token);

    const accountId = res.body.data.account.id as string;
    const diag = await api("GET", `/api/accounts/${accountId}/diagnose`, { cookie: u.cookie });
    expect(JSON.stringify(diag.body)).not.toContain(token);
  });
});

describe("DELETE /api/accounts/:id（SPEC §7.1）", () => {
  it("関連テーブルが全部消える", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("del1") });
    const db = testDb();

    // 一通りデータを作る
    const ctx = makeJobContext(env, { now: NOW });
    for (const t of ["full_sync", "insights_recent", "daily_views", "followers", "demographics", "clicks"] as const) {
      await enqueueJob(ctx, t, { accountId });
    }
    await runJobs(ctx);
    // ジョブ以外の残りも足しておく
    const nowIso = NOW.toISOString();
    await db.run(
      "INSERT INTO queue (id, account_id, status, body, created_at, updated_at) VALUES (?,?,'draft','x',?,?)",
      crypto.randomUUID(),
      accountId,
      nowIso,
      nowIso,
    );
    await db.run(
      "INSERT INTO learning (account_id, dim, value, n, updated_at) VALUES (?,'hook','警告型',1,?)",
      accountId,
      nowIso,
    );
    await db.run(
      "INSERT INTO ap_log (id, account_id, at, kind, message) VALUES (?,?,?,'plan','x')",
      crypto.randomUUID(),
      accountId,
      nowIso,
    );
    await db.run(
      "INSERT OR IGNORE INTO post_metrics_history (account_id, post_id, checkpoint, at, views) SELECT account_id, id, '48h', ?, 1 FROM posts WHERE account_id=? LIMIT 1",
      nowIso,
      accountId,
    );

    // 消す前にどのテーブルにも行があること
    for (const t of ACCOUNT_CHILD_TABLES) {
      const n = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${t} WHERE account_id=?`,
        accountId,
      );
      expect({ table: t, n: n?.n }).toEqual({ table: t, n: expect.any(Number) });
      expect(n!.n).toBeGreaterThan(0);
    }

    const res = await api("DELETE", `/api/accounts/${accountId}`, { cookie: u.cookie });
    expect(res.status).toBe(200);

    for (const t of ACCOUNT_CHILD_TABLES) {
      const n = await db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${t} WHERE account_id=?`,
        accountId,
      );
      expect({ table: t, n: n!.n }).toEqual({ table: t, n: 0 });
    }
    const account = await db.first("SELECT id FROM accounts WHERE id=?", accountId);
    expect(account).toBeNull();
  });
});

describe("sync / diagnose / patch（SPEC §7.1）", () => {
  it("POST /sync は重複投入せず、GET /sync が進捗を返す", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("sy1") });

    const first = await api("POST", `/api/accounts/${accountId}/sync`, { cookie: u.cookie });
    expect(first.body.data.queued).toBe(true);
    const second = await api("POST", `/api/accounts/${accountId}/sync`, { cookie: u.cookie });
    expect(second.body.data.queued).toBe(false);

    const running = await api("GET", `/api/accounts/${accountId}/sync`, { cookie: u.cookie });
    expect(running.body.data).toMatchObject({ running: true, status: "syncing", progress: 0, total: SYNC_TOTAL_PAGES });

    // `POST /sync` はルート経由なので `next_run_at` を**実時計**で書く。ジョブを回す側の
    // `now` が実時計より前だと「まだ期限が来ていない」と判定されて進まない（固定の NOW を
    // そのまま渡すと、実時間が NOW を追い越した日から落ちる）。両方の遅い方を使う
    const runAt = new Date(Math.max(NOW.getTime(), Date.now()));
    for (let i=0;i<5;i++) {
      await runJobs(makeJobContext(env, { now: new Date(runAt.getTime() + i * 1000) }));
    }
    const done = await api("GET", `/api/accounts/${accountId}/sync`, { cookie: u.cookie });
    expect(done.body.data).toMatchObject({
      running: false,
      progress: SYNC_TOTAL_PAGES,
      total: SYNC_TOTAL_PAGES,
    });
  });

  it("diagnose は6段返す", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("dg1") });
    const res = await api("GET", `/api/accounts/${accountId}/diagnose`, { cookie: u.cookie });
    expect(res.status).toBe(200);
    const steps = res.body.data.steps as Array<{ name: string; ok: boolean; detail: string }>;
    expect(steps.map((s) => s.name)).toEqual([
      "トークン",
      "アカウント情報",
      "投稿の取得",
      "投稿の数字",
      "アカウントの表示回数",
      "リンクのクリック",
    ]);
    expect(steps.every((s) => s.ok)).toBe(true);
  });

  it("PATCH で色・タイムゾーンを変えられる。おかしな tz は弾く", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("pt1") });

    const okRes = await api("PATCH", `/api/accounts/${accountId}`, {
      cookie: u.cookie,
      body: { color: "#123456", timezone: "America/New_York" },
    });
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.account.color).toBe("#123456");
    expect(okRes.body.data.account.timezone).toBe("America/New_York");

    const bad = await api("PATCH", `/api/accounts/${accountId}`, {
      cookie: u.cookie,
      body: { timezone: "Mars/Olympus" },
    });
    expect(bad.status).toBe(400);
  });

  it("有効期限未確認でもAPIが延長を受け付ければ長期トークンとして保存する", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("rt1") });
    const res = await api("POST", `/api/accounts/${accountId}/refresh-token`, { cookie: u.cookie });
    expect(res.status).toBe(200);
    expect(res.body.data.refreshed).toBe(true);
    expect(res.body.data.message).toContain("延長");
  });

  it("長期トークンは延長でき、期限が戻る", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({
      userId: u.userId,
      token: mockToken("rt2"),
      longLived: true,
      tokenObtainedAt: new Date(Date.now() - 50 * 86400_000).toISOString(),
    });
    const res = await api("POST", `/api/accounts/${accountId}/refresh-token`, { cookie: u.cookie });
    expect(res.body.data.refreshed).toBe(true);
    expect(res.body.data.tokenExpiresInDays).toBe(60);
  });
});

describe("GET /api/accounts/:id/dashboard（SPEC §7.2）", () => {
  // Keep the API's rolling window aligned with the fixed September mock posts.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  async function seeded(suffix: string) {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken(suffix) });
    const ctx = makeJobContext(env, { now: new Date() });
    for (const t of ["full_sync", "insights_recent", "insights_daily", "daily_views", "followers", "clicks"] as const) {
      await enqueueJob(ctx, t, { accountId });
    }
    await runJobs(ctx);
    return { u, accountId };
  }

  it("§7.2 の形で返る", async () => {
    const { u, accountId } = await seeded("dash1");
    const roots=await testDb().all<{id:string}>("SELECT id FROM posts WHERE account_id=? AND is_reply=0",accountId);
    for (const root of roots) {
      let pending=true;
      while (pending) {
        const tree=await api("GET",`/api/accounts/${accountId}/posts/${root.id}/tree`,{cookie:u.cookie});
        expect(tree.status).toBe(200);pending=tree.body.data.pending;
      }
    }
    const res = await api("GET", `/api/accounts/${accountId}/dashboard?period=30`, {
      cookie: u.cookie,
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.period).toBe(30);
    expect(typeof d.from).toBe("string");
    expect(typeof d.to).toBe("string");
    expect(d.followers).toEqual({
      current: expect.any(Number),
      delta: expect.any(Number),
      series: expect.any(Array),
    });
    expect(d.views.series.length).toBeGreaterThan(0);
    expect(d.views.total).toBeGreaterThan(0);
    expect(typeof d.likes).toBe("number");
    expect(typeof d.clicks).toBe("number");
    expect(typeof d.unassignedClicks).toBe("number");

    // 投稿は root だけ。children を含む
    expect(d.posts.length).toBeGreaterThan(0);
    const withChildren = d.posts.find((p: { children: unknown[] }) => p.children.length > 0);
    expect(withChildren).toBeTruthy();
    expect(withChildren.hook).toBeTruthy();
    expect(withChildren.link).toBeTruthy();
    expect(withChildren.link.url).toMatch(/^https:\/\//);

    // リンク別クリック
    expect(d.links.length).toBeGreaterThan(0);
    expect(d.links[0]).toEqual({
      url: expect.any(String),
      label: expect.any(String),
      kind: expect.any(String),
      clicks: expect.any(Number),
      posts: expect.any(Number),
    });
  });

  it("スナップショットが1点しかないと delta は 0", async () => {
    const { u, accountId } = await seeded("dash2");
    const res = await api("GET", `/api/accounts/${accountId}/dashboard?period=7`, {
      cookie: u.cookie,
    });
    expect(res.body.data.followers.series).toHaveLength(1);
    expect(res.body.data.followers.delta).toBe(0);
  });

  it("period=all も受ける。おかしな period は 7 に丸める", async () => {
    const { u, accountId } = await seeded("dash3");
    expect(
      (await api("GET", `/api/accounts/${accountId}/dashboard?period=all`, { cookie: u.cookie }))
        .body.data.period,
    ).toBe("all");
    expect(
      (await api("GET", `/api/accounts/${accountId}/dashboard?period=999`, { cookie: u.cookie }))
        .body.data.period,
    ).toBe(7);
  });

});

describe("GET /api/accounts/:id/posts（SPEC §7.3）", () => {
  it("一覧・詳細・履歴が返る", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("pl1") });
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "full_sync", { accountId });
    await enqueueJob(ctx, "insights_recent", { accountId });
    await enqueueJob(ctx, "insights_daily", { accountId });
    await runJobs(ctx);

    const list = await api("GET", `/api/accounts/${accountId}/posts?sort=views&limit=5`, {
      cookie: u.cookie,
    });
    expect(list.status).toBe(200);
    expect(list.body.data.posts).toHaveLength(5);
    expect(list.body.data.cursor).toBe("5");
    expect(list.body.data.total).toBeGreaterThanOrEqual(5);
    const views = list.body.data.posts.map((p: { views: number }) => p.views);
    expect([...views].sort((a: number, b: number) => b - a)).toEqual(views);

    const postId = list.body.data.posts[0].id as string;
    const detail = await api("GET", `/api/accounts/${accountId}/posts/${postId}`, {
      cookie: u.cookie,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.data.post.id).toBe(postId);
    expect(Array.isArray(detail.body.data.history)).toBe(true);

    const search = await api("GET", `/api/accounts/${accountId}/posts?q=${encodeURIComponent("危険")}`, {
      cookie: u.cookie,
    });
    expect(search.body.data.posts.length).toBeGreaterThan(0);
  });
});

describe("GET/POST /api/accounts/:id/links（SPEC §7.5）", () => {
  it("同期で自動追加され、ラベルと種別を後から直せる", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("lk1") });
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "full_sync", { accountId });
    await runJobs(ctx);

    const list = await api("GET", `/api/accounts/${accountId}/links`, { cookie: u.cookie });
    expect(list.body.data.links.length).toBeGreaterThan(0);
    const link = list.body.data.links.find((l: { url: string }) => l.url === "https://lin.ee/threadsdemo");
    expect(link.label).toBe("https://lin.ee/threadsdemo");

    const patched = await api("PATCH", `/api/accounts/${accountId}/links/${link.id}`, {
      cookie: u.cookie,
      body: { label: "公式LINE", kind: "line" },
    });
    expect(patched.body.data.link).toMatchObject({ label: "公式LINE", kind: "line" });

    // 追加は正規化してから入る
    const added = await api("POST", `/api/accounts/${accountId}/links`, {
      cookie: u.cookie,
      body: { url: "https://example.com/new/?utm_source=x#frag", label: "新規" },
    });
    expect(added.status).toBe(201);
    expect(added.body.data.link.url).toBe("https://example.com/new");

    const del = await api("DELETE", `/api/accounts/${accountId}/links/${link.id}`, {
      cookie: u.cookie,
    });
    expect(del.status).toBe(200);
  });
});

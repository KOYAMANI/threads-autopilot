/**
 * オートパイロットの採点・計画・通知（SPEC §9 / §7.7 / §7.8 / §10.5）と、
 * メールからの承認/取消（SPEC §7.9）。
 *
 * AI は `AI_MOCK=1`（DEV ガード）、Threads は `THREADS_MOCK`。実キー・実 URL は使わない。
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_SAMPLES_LEARNING } from "@tap/shared";
import { api, insertAccount, mockToken, registerUser, testDb } from "./helpers";
import { resetMock } from "../src/mock/threads";
import { clearOutbox, getOutbox } from "../src/lib/email";
import { makeJobContext } from "../src/lib/jobs";
import { scoreAccount } from "../src/jobs/score";
import { planAccount } from "../src/jobs/plan";
import { notifyAccount } from "../src/jobs/notify";
import { publishJob } from "../src/jobs/publish";
import { handleAction } from "../src/routes/action";
import { actionUrl } from "../src/lib/notify";

const NOW = new Date("2026-09-07T02:00:00.000Z"); // 平日（月）11:00 JST

beforeEach(() => {
  resetMock();
  clearOutbox();
});

/** AI_MOCK を有効にして走らせる。 */
function withAiMock<T>(fn: () => Promise<T>): Promise<T> {
  const before = (env as { AI_MOCK?: string }).AI_MOCK;
  (env as { AI_MOCK?: string }).AI_MOCK = "1";
  return fn().finally(() => {
    (env as { AI_MOCK?: string }).AI_MOCK = before;
  });
}

type Fixture = {
  cookie: string;
  userId: string;
  accountId: string;
  email: string;
};

/** AI キー（サーバー保存）・参考情報・リンクまでそろったアカウントを作る。 */
async function fixture(suffix: string, options: { sources?: number } = {}): Promise<Fixture> {
  const u = await registerUser();
  const accountId = await insertAccount({ userId: u.userId, token: mockToken(suffix) });
  await api("PUT", "/api/ai/settings", {
    cookie: u.cookie,
    body: { acceptDataPolicy: true, geminiBillingConfirmed: true, provider: "gemini", key: "AIzaTESTKEY0123456789", storeOnServer: true },
  });
  const n = options.sources ?? 2;
  for (let i = 0; i < n; i++) {
    await api("POST", "/api/sources", {
      cookie: u.cookie,
      body: {
        type: "text",
        title: `ネタ源${i + 1}`,
        content: `下書きを${i + 1}本ためると翌朝が楽になる、という話のメモ。`,
      },
    });
  }
  await api("POST", `/api/accounts/${accountId}/links`, {
    cookie: u.cookie,
    body: { url: "https://example.com/line", label: "公式LINE", kind: "line" },
  });
  return { cookie: u.cookie, userId: u.userId, accountId, email: u.email };
}

async function enableAp(f: Fixture, patch: Record<string, unknown> = {}) {
  return api("PUT", `/api/accounts/${f.accountId}/autopilot`, {
    cookie: f.cookie,
    body: { enabled: true, ...patch },
  });
}

/* ═══ ON にできる条件（SPEC §7.7） ═══════════════════ */

describe("GET/PUT /autopilot（SPEC §7.7）", () => {
  it("AIキーが端末保存なら ON にできない（理由つきで断る）", async () => {
    const f = await fixture("ap-key");
    await testDb().run("UPDATE ai_settings SET store_on_server=0,key_enc=NULL WHERE user_id=?",f.userId);
    const got = await api("GET", `/api/accounts/${f.accountId}/autopilot`, { cookie: f.cookie });
    expect(got.body.data.canEnable).toBe(false);
    expect(got.body.data.blockers).toContain("no_key");
    expect(got.body.data.blockerMessages[0]).toContain("送信先・利用条件を確認");

    const put = await enableAp(f);
    expect(put.status).toBe(409);
    expect(put.body.error.code).toBe("AP_BLOCKED");
  });

  it("参考情報が0件なら ON にできない", async () => {
    const f = await fixture("ap-src", { sources: 0 });
    const got = await api("GET", `/api/accounts/${f.accountId}/autopilot`, { cookie: f.cookie });
    expect(got.body.data.blockers).toContain("no_source");
    expect((await enableAp(f)).status).toBe(409);
  });

  it("再接続が必要なアカウントは ON にできない", async () => {
    const f = await fixture("ap-reauth");
    await testDb().run("UPDATE accounts SET status='needs_reauth' WHERE id=?", f.accountId);
    const got = await api("GET", `/api/accounts/${f.accountId}/autopilot`, { cookie: f.cookie });
    expect(got.body.data.blockers).toContain("needs_reauth");
    expect((await enableAp(f)).status).toBe(409);
  });

  it("ライセンスが revoked なら ON にできない", async () => {
    const f = await fixture("ap-lic");
    await testDb().run(
      "UPDATE licenses SET status='revoked' WHERE id=(SELECT license_id FROM users WHERE id=?)",
      f.userId,
    );
    const got = await api("GET", `/api/accounts/${f.accountId}/autopilot`, { cookie: f.cookie });
    expect(got.body.data.blockers).toContain("license");
    expect((await enableAp(f)).status).toBe(409);
  });

  it("4条件がそろえば ON にでき、設定が保存される", async () => {
    const f = await fixture("ap-ok");
    const got = await api("GET", `/api/accounts/${f.accountId}/autopilot`, { cookie: f.cookie });
    expect(got.body.data.canEnable).toBe(true);

    const put = await enableAp(f, { perWeek: 14, approvalMode: "cancel", approvalWindowH: 4 });
    expect(put.status).toBe(200);
    expect(put.body.data.settings.enabled).toBe(true);
    expect(put.body.data.settings.perWeek).toBe(14);

    const again = await api("GET", `/api/accounts/${f.accountId}/autopilot`, { cookie: f.cookie });
    expect(again.body.data.settings.approvalMode).toBe("cancel");
    expect(again.body.data.settings.approvalWindowH).toBe(4);
  });

  it("他人のアカウントの設定は見えないし触れない", async () => {
    const a = await fixture("ap-own1");
    const b = await fixture("ap-own2");
    expect(
      (await api("GET", `/api/accounts/${a.accountId}/autopilot`, { cookie: b.cookie })).status,
    ).toBe(404);
    expect(
      (await api("PUT", `/api/accounts/${a.accountId}/autopilot`, {
        cookie: b.cookie,
        body: { enabled: true },
      })).status,
    ).toBe(404);
  });
});

/* ═══ 採点（SPEC §9.2） ═════════════════════════════ */

/** 48h チェックポイントつきの root 投稿をまとめて作る。 */
async function seedScorable(
  accountId: string,
  count: number,
  options: { with48h?: boolean; startId?: number } = {},
): Promise<string[]> {
  const db = testDb();
  const with48h = options.with48h ?? true;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `sc${options.startId ?? 0}_${i}`;
    ids.push(id);
    // 5日前の 21:00 JST 前後にばらす
    const postedAt = new Date(NOW.getTime() - (5 + i) * 86_400_000).toISOString();
    await db.run(
      `INSERT INTO posts (account_id, id, root_id, is_reply, text, posted_at, views, likes, clicks, tags_json, source)
         VALUES (?,?,?,0,?,?,?,?,0,'{}','external')`,
      accountId,
      id,
      id,
      `危険です。${i}本目の見本の本文。`,
      postedAt,
      1000 + i * 100,
      20 + i,
    );
    if (with48h) {
      await db.run(
        `INSERT INTO post_metrics_history (account_id, post_id, checkpoint, at, views, likes, replies, reposts, quotes)
           VALUES (?,?, '48h', ?, ?, ?, 0, 0, 0)`,
        accountId,
        id,
        postedAt,
        800 + i * 100,
        15 + i,
      );
    }
  }
  return ids;
}

describe("ap_score（SPEC §9.2）", () => {
  it("48h 行のある投稿だけ採点し、learning が4次元で増える", async () => {
    const f = await fixture("sc1");
    await seedScorable(f.accountId, 12, { startId: 1 });
    const noHistory = await seedScorable(f.accountId, 2, { with48h: false, startId: 9 });

    const ctx = makeJobContext(env, { now: NOW });
    const res = await scoreAccount(ctx, f.accountId);
    expect(res.scored).toBe(12);
    expect(res.skipped).toBe(2); // 48h 行が無い2本

    const db = testDb();
    const dims = await db.all<{ dim: string; n: number }>(
      "SELECT dim, SUM(n) AS n FROM learning WHERE account_id=? GROUP BY dim ORDER BY dim",
      f.accountId,
    );
    expect(dims.map((d) => d.dim)).toEqual(["hook", "length", "slot", "source"]);
    for (const d of dims) expect(d.n).toBe(12);

    // 48h 行の無い投稿には scored を付けない（次の日次で拾い直す。SPEC §9.2）
    const un = await db.first<{ tags_json: string }>(
      "SELECT tags_json FROM posts WHERE account_id=? AND id=?",
      f.accountId,
      noHistory[0]!,
    );
    expect(un!.tags_json).not.toContain("scored");
  });

  it("query exhaustion between learning and marker cannot double-count on resume", async () => {
    const f = await fixture("free-score");
    await seedScorable(f.accountId, 12, {startId:91});
    // Four setup queries + child lookup leave room for only half of the old two-write sequence.
    await expect(scoreAccount(makeJobContext(env, {now:NOW, dbQueries:6}), f.accountId)).rejects.toThrow("budget exceeded");
    await scoreAccount(makeJobContext(env, {now:NOW}), f.accountId);
    const dims = await testDb().all<{n:number}>("SELECT SUM(n) n FROM learning WHERE account_id=? GROUP BY dim", f.accountId);
    expect(dims).toHaveLength(4);
    for (const d of dims) expect(d.n).toBe(12);
  });

  it("採点は48時間の1回だけ。2回走らせても n は増えない", async () => {
    const f = await fixture("sc2");
    await seedScorable(f.accountId, 11, { startId: 2 });
    await scoreAccount(makeJobContext(env, { now: NOW }), f.accountId);
    const after1 = await countLearning(f.accountId);
    const second = await scoreAccount(
      makeJobContext(env, { now: new Date(NOW.getTime() + 10 * 86_400_000) }),
      f.accountId,
    );
    expect(second.scored).toBe(0);
    expect(await countLearning(f.accountId)).toBe(after1);
  });

  it("分布の母数が10本未満なら採点を見送る（scored を付けない）", async () => {
    const f = await fixture("sc3");
    const ids = await seedScorable(f.accountId, 5, { startId: 3 });
    const res = await scoreAccount(makeJobContext(env, { now: NOW }), f.accountId);
    expect(res.scored).toBe(0);
    expect(res.reason).toContain("母数");
    const row = await testDb().first<{ tags_json: string }>(
      "SELECT tags_json FROM posts WHERE account_id=? AND id=?",
      f.accountId,
      ids[0]!,
    );
    expect(row!.tags_json).not.toContain("scored");
  });

  it("48h 行を後から入れると、次の日次で採点される", async () => {
    const f = await fixture("sc4");
    await seedScorable(f.accountId, 11, { startId: 4 });
    const late = (await seedScorable(f.accountId, 1, { with48h: false, startId: 8 }))[0]!;
    await scoreAccount(makeJobContext(env, { now: NOW }), f.accountId);

    const db = testDb();
    await db.run(
      `INSERT INTO post_metrics_history (account_id, post_id, checkpoint, at, views, likes, replies, reposts, quotes)
         VALUES (?,?, '48h', ?, 1500, 40, 0, 0, 0)`,
      f.accountId,
      late,
      NOW.toISOString(),
    );
    const second = await scoreAccount(
      makeJobContext(env, { now: new Date(NOW.getTime() + 86_400_000) }),
      f.accountId,
    );
    expect(second.scored).toBe(1);
  });
});

async function countLearning(accountId: string): Promise<number> {
  const row = await testDb().first<{ n: number }>(
    "SELECT COALESCE(SUM(n),0) AS n FROM learning WHERE account_id=?",
    accountId,
  );
  return row?.n ?? 0;
}

/* ═══ /autopilot/learning（SPEC §7.7 / §12.3） ══════ */

describe("GET /autopilot/learning（SPEC §7.7）", () => {
  it("n < 10 の行は avgScore / avgViews / likeRate が null", async () => {
    const f = await fixture("lrn1");
    const db = testDb();
    await db.run(
      `INSERT INTO learning (account_id, dim, value, n, score_sum, views_sum, like_rate_sum, updated_at)
         VALUES (?,'hook','警告型',?,6.0,12000,0.24,?),(?,'hook','疑問型',3,1.2,3000,0.05,?)`,
      f.accountId,
      MIN_SAMPLES_LEARNING,
      NOW.toISOString(),
      f.accountId,
      NOW.toISOString(),
    );
    const res = await api("GET", `/api/accounts/${f.accountId}/autopilot/learning`, {
      cookie: f.cookie,
    });
    const rows = res.body.data.rows as Array<{
      value: string;
      n: number;
      avgViews: number | null;
      likeRate: number | null;
      avgScore: number | null;
    }>;
    const warn = rows.find((r) => r.value === "警告型")!;
    const q = rows.find((r) => r.value === "疑問型")!;
    expect(warn.avgViews).toBe(1200);
    expect(warn.likeRate).toBeCloseTo(0.024, 5);
    expect(warn.avgScore).toBeCloseTo(0.6, 5);
    expect(q.n).toBe(3);
    expect(q.avgViews).toBeNull();
    expect(q.likeRate).toBeNull();
    expect(q.avgScore).toBeNull();
  });

  it("枠は「平日 21時台」の形のラベルを付けて返す（SPEC §12.3）", async () => {
    const f = await fixture("lrn2");
    await testDb().run(
      `INSERT INTO learning (account_id, dim, value, n, score_sum, views_sum, like_rate_sum, updated_at)
         VALUES (?,'slot','weekday-21',12,7.2,24000,0.3,?),(?,'slot','weekend-12',11,5.5,11000,0.2,?)`,
      f.accountId,
      NOW.toISOString(),
      f.accountId,
      NOW.toISOString(),
    );
    const res = await api("GET", `/api/accounts/${f.accountId}/autopilot/learning`, {
      cookie: f.cookie,
    });
    const rows = res.body.data.rows as Array<{ value: string; label: string | null }>;
    expect(rows.find((r) => r.value === "weekday-21")!.label).toBe("平日 21時台");
    expect(rows.find((r) => r.value === "weekend-12")!.label).toBe("土日 12時台");
  });
});

/* ═══ ap_plan（SPEC §9.4） ═════════════════════════ */

describe("ap_plan（SPEC §9.4）", () => {
  it("24時間ぶんの下書きができ、source='autopilot' で入る", async () => {
    const f = await fixture("plan1");
    await enableAp(f, { perWeek: 7, approvalMode: "cancel", approvalWindowH: 4 });

    const res = await withAiMock(() =>
      planAccount(makeJobContext(env, { now: NOW }), f.accountId),
    );
    expect(res.planned).toHaveLength(1);

    const row = await testDb().first<{
      status: string;
      source: string;
      approval_mode: string;
      scheduled_at: string;
      approve_deadline: string;
      body: string;
      tags_json: string;
      source_ids_json: string;
    }>(
      "SELECT status, source, approval_mode, scheduled_at, approve_deadline, body, tags_json, source_ids_json FROM queue WHERE account_id=? AND source='autopilot'",
      f.accountId,
    );
    expect(row!.source).toBe("autopilot");
    expect(row!.status).toBe("scheduled");
    expect(row!.approval_mode).toBe("cancel");
    expect(row!.body.length).toBeGreaterThan(0);
    // approve_deadline = scheduled_at - approval_window_h
    expect(Date.parse(row!.scheduled_at) - Date.parse(row!.approve_deadline)).toBe(4 * 3_600_000);
    expect(JSON.parse(row!.source_ids_json)).toHaveLength(1);
    expect(JSON.parse(row!.tags_json).hook).toBeTruthy();

    const log = await testDb().first<{ message: string }>(
      "SELECT message FROM ap_log WHERE account_id=? AND kind='plan' AND message LIKE '%下書きを作りました%' ORDER BY at DESC LIMIT 1",
      f.accountId,
    );
    expect(log!.message).toContain("下書きを作りました");
  });

  it("approval_mode='manual' は pending_approval で入る", async () => {
    const f = await fixture("plan2");
    await enableAp(f, { approvalMode: "manual" });
    await withAiMock(() => planAccount(makeJobContext(env, { now: NOW }), f.accountId));
    const row = await testDb().first<{ status: string; approve_deadline: string | null }>(
      "SELECT status, approve_deadline FROM queue WHERE account_id=? AND source='autopilot'",
      f.accountId,
    );
    expect(row!.status).toBe("pending_approval");
    expect(row!.approve_deadline).toBeNull();
  });

  it("approval_mode='auto' は scheduled ＋ 締切なし", async () => {
    const f = await fixture("plan3");
    await enableAp(f, { approvalMode: "auto" });
    await withAiMock(() => planAccount(makeJobContext(env, { now: NOW }), f.accountId));
    const row = await testDb().first<{ status: string; approve_deadline: string | null }>(
      "SELECT status, approve_deadline FROM queue WHERE account_id=? AND source='autopilot'",
      f.accountId,
    );
    expect(row!.status).toBe("scheduled");
    expect(row!.approve_deadline).toBeNull();
  });

  it("すでに足りていれば作らない（同じ日に二重に積まない）", async () => {
    const f = await fixture("plan4");
    await enableAp(f, { perWeek: 7 });
    const ctx = () => makeJobContext(env, { now: NOW });
    await withAiMock(() => planAccount(ctx(), f.accountId));
    const second = await withAiMock(() => planAccount(ctx(), f.accountId));
    expect(second.planned).toHaveLength(0);
    expect(await countQueue(f.accountId)).toBe(1);
  });

  it("先の日に置かれた下書きも在庫として数える（毎時走らせても積み上がらない）", async () => {
    const f = await fixture("plan4b");
    await enableAp(f, { perWeek: 7, dailyLimit: 1 });
    // 直近7日を手動の予約で埋めて、自動の枠が先の日にしか取れない状態を作る
    const db = testDb();
    for (let d = 0; d < 6; d++) {
      await db.run(
        `INSERT INTO queue (id, account_id, status, scheduled_at, body, comments_json, reply_control,
            source, step, container_polls, result_ids_json, attempts, tags_json, source_ids_json,
            created_at, updated_at)
          VALUES (?,?, 'scheduled', ?, ?, '[]', 'everyone', 'manual', 0, 0, '[]', 0, '{}', '[]', ?, ?)`,
        crypto.randomUUID(),
        f.accountId,
        new Date(NOW.getTime() + (d + 1) * 86_400_000).toISOString(),
        `手動の予約 ${d}`,
        NOW.toISOString(),
        NOW.toISOString(),
      );
    }
    // 毎時のつもりで6回まわす。1本作ったら、あとは在庫があるので作らない
    for (let h = 0; h < 6; h++) {
      await withAiMock(() =>
        planAccount(makeJobContext(env, { now: new Date(NOW.getTime() + h * 3_600_000) }), f.accountId),
      );
    }
    expect(await countQueue(f.accountId)).toBe(1);
  });

  it("オフのアカウントは計画しない", async () => {
    const f = await fixture("plan5");
    const res = await withAiMock(() => planAccount(makeJobContext(env, { now: NOW }), f.accountId));
    expect(res.skipped).toContain("オフ");
    expect(await countQueue(f.accountId)).toBe(0);
  });

  it("needs_reauth のアカウントは計画しない（SPEC §9.6）", async () => {
    const f = await fixture("plan6");
    await enableAp(f);
    await testDb().run("UPDATE accounts SET status='needs_reauth' WHERE id=?", f.accountId);
    const res = await withAiMock(() => planAccount(makeJobContext(env, { now: NOW }), f.accountId));
    expect(res.skipped).toContain("再接続");
    expect(await countQueue(f.accountId)).toBe(0);
  });

  it("ライセンスが revoked なら計画せず、enabled=0 にして ap_log に残す（SPEC §5.4）", async () => {
    const f = await fixture("plan7");
    await enableAp(f);
    await testDb().run(
      "UPDATE licenses SET status='revoked' WHERE id=(SELECT license_id FROM users WHERE id=?)",
      f.userId,
    );
    const res = await withAiMock(() => planAccount(makeJobContext(env, { now: NOW }), f.accountId));
    expect(res.skipped).toContain("ライセンス");
    const ap = await testDb().first<{ enabled: number }>(
      "SELECT enabled FROM autopilot WHERE account_id=?",
      f.accountId,
    );
    expect(ap!.enabled).toBe(0);
    const log = await testDb().first<{ message: string }>(
      "SELECT message FROM ap_log WHERE account_id=? AND kind='stopped'",
      f.accountId,
    );
    expect(log!.message).toContain("ライセンス");
  });

  it("3回続けて失敗すると enabled=0 になり、ap_stopped メールが出る（SPEC §9.4-4）", async () => {
    const f = await fixture("plan8", { sources: 1 });
    await enableAp(f);
    const db = testDb();
    // ネタ源を「7日以内に使用済み」にして、選べない状態を作る
    await db.run("UPDATE sources SET last_used_at=? WHERE user_id=?", NOW.toISOString(), f.userId);

    for (let i = 0; i < 3; i++) {
      await withAiMock(() =>
        planAccount(makeJobContext(env, { now: new Date(NOW.getTime() + i * 3_600_000) }), f.accountId),
      );
    }
    const ap = await db.first<{ enabled: number; consecutive_failures: number }>(
      "SELECT enabled, consecutive_failures FROM autopilot WHERE account_id=?",
      f.accountId,
    );
    expect(ap!.consecutive_failures).toBe(3);
    expect(ap!.enabled).toBe(0);
    const stopped = getOutbox().filter((m) => m.template === "ap_stopped" && m.to === f.email);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.text).toContain("3回続けて失敗");
  });

  it("link_placement='comment' なら本文にURLが入らず、コメントにリンクが付く（SPEC §9.6）", async () => {
    const f = await fixture("plan9");
    await enableAp(f, { linkPlacement: "comment" });
    await withAiMock(() => planAccount(makeJobContext(env, { now: NOW }), f.accountId));
    const row = await testDb().first<{ body: string; comments_json: string }>(
      "SELECT body, comments_json FROM queue WHERE account_id=? AND source='autopilot'",
      f.accountId,
    );
    expect(row!.body).not.toContain("http");
    expect(row!.comments_json).toContain("https://example.com/line");
  });
});

async function countQueue(accountId: string, source = "autopilot"): Promise<number> {
  const row = await testDb().first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM queue WHERE account_id=? AND source=?",
    accountId,
    source,
  );
  return row?.n ?? 0;
}

/* ═══ 安全装置: link_placement を publish でも見る（SPEC §9.6） ═══ */

describe("publish の安全装置（SPEC §9.6）", () => {
  it("link_placement='comment' なのに本文にURLがあると、AP のキューは弾かれる", async () => {
    const f = await fixture("safe1");
    await enableAp(f, { linkPlacement: "comment" });
    const db = testDb();
    const qid = crypto.randomUUID();
    await db.run(
      `INSERT INTO queue (id, account_id, status, scheduled_at, body, comments_json, reply_control,
          source, approval_mode, step, container_polls, result_ids_json, attempts, tags_json,
          source_ids_json, created_at, updated_at)
        VALUES (?,?, 'scheduled', ?, ?, '[]', 'everyone', 'autopilot', 'auto', 0, 0, '[]', 0, '{}', '[]', ?, ?)`,
      qid,
      f.accountId,
      NOW.toISOString(),
      "本文にURLを入れてしまいました https://example.com/line",
      NOW.toISOString(),
      NOW.toISOString(),
    );

    const ctx = makeJobContext(env, { now: new Date(NOW.getTime() + 60_000) });
    await publishJob(ctx, { id: "j", type: "publish", accountId: f.accountId, attempts: 0, state: {} });

    const row = await db.first<{ status: string; error: string }>(
      "SELECT status, error FROM queue WHERE id=?",
      qid,
    );
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain("リンクはコメントに置く設定です");
  });

  it("手で書いた投稿（manual）は本文にURLがあっても通る", async () => {
    const f = await fixture("safe2");
    await enableAp(f, { linkPlacement: "comment" });
    const db = testDb();
    const qid = crypto.randomUUID();
    await db.run(
      `INSERT INTO queue (id, account_id, status, scheduled_at, body, comments_json, reply_control,
          source, approval_mode, step, container_polls, result_ids_json, attempts, tags_json,
          source_ids_json, created_at, updated_at)
        VALUES (?,?, 'scheduled', ?, ?, '[]', 'everyone', 'manual', NULL, 0, 0, '[]', 0, '{}', '[]', ?, ?)`,
      qid,
      f.accountId,
      NOW.toISOString(),
      "手で書いた投稿です https://example.com/line",
      NOW.toISOString(),
      NOW.toISOString(),
    );
    const ctx = makeJobContext(env, { now: new Date(NOW.getTime() + 60_000) });
    await publishJob(ctx, { id: "j", type: "publish", accountId: f.accountId, attempts: 0, state: {} });
    const row = await db.first<{ status: string }>("SELECT status FROM queue WHERE id=?", qid);
    expect(row!.status).toBe("done");
  });
});

/* ═══ ap_notify（SPEC §9.5）とメール（§10.5） ══════ */

describe("ap_notify（SPEC §9.5）", () => {
  it("cancel は approve_deadline を過ぎたら通知し、本文に /a/<token> が入る", async () => {
    const f = await fixture("nt1");
    await enableAp(f, { approvalMode: "cancel", approvalWindowH: 4 });
    await withAiMock(() => planAccount(makeJobContext(env, { now: NOW }), f.accountId));

    const q = await testDb().first<{ id: string; approve_deadline: string }>(
      "SELECT id, approve_deadline FROM queue WHERE account_id=? AND source='autopilot'",
      f.accountId,
    );

    // 締切前は送らない
    const before = await notifyAccount(makeJobContext(env, { now: NOW }), f.accountId);
    expect(before.sent).toBe(0);

    // 締切後は送る
    const at = new Date(Date.parse(q!.approve_deadline) + 60_000);
    const after = await notifyAccount(makeJobContext(env, { now: at }), f.accountId);
    expect(after.sent).toBe(1);

    const mail = getOutbox().find((m) => m.template === "ap_draft" && m.to === f.email)!;
    expect(mail).toBeTruthy();
    expect(mail.subject).toContain("取り消せます");
    expect(mail.text).toMatch(/https?:\/\/[^\s]+\/a\/[A-Za-z0-9_.-]+/);
    expect(mail.text).not.toContain("承認して投稿する"); // cancel モードに承認リンクは出さない

    // 二度は送らない
    const again = await notifyAccount(
      makeJobContext(env, { now: new Date(at.getTime() + 3_600_000) }),
      f.accountId,
    );
    expect(again.sent).toBe(0);
  });

  it("manual は作成直後に通知し、承認と取消の両方のリンクを載せる", async () => {
    const f = await fixture("nt2");
    await enableAp(f, { approvalMode: "manual" });
    await withAiMock(() => planAccount(makeJobContext(env, { now: NOW }), f.accountId));
    const res = await notifyAccount(makeJobContext(env, { now: NOW }), f.accountId);
    expect(res.sent).toBe(1);
    const mail = getOutbox().find((m) => m.template === "ap_draft")!;
    expect(mail.subject).toContain("承認してください");
    expect(mail.text).toContain("承認して投稿する");
    expect(mail.text).toContain("取り消す");
  });

  it("メール通知がオフなら送らない（SPEC §7.8）", async () => {
    const f = await fixture("nt3");
    await api("PUT", "/api/notifications", { cookie: f.cookie, body: { emailEnabled: false } });
    await enableAp(f, { approvalMode: "manual" });
    await withAiMock(() => planAccount(makeJobContext(env, { now: NOW }), f.accountId));
    const res = await notifyAccount(makeJobContext(env, { now: NOW }), f.accountId);
    expect(res.sent).toBe(0);
    expect(getOutbox().filter((m) => m.to === f.email)).toHaveLength(0);
  });
});

/* ═══ /a/:token（SPEC §7.9） ═══════════════════════ */

/** Cookie を一切付けずに `/a/:token` を叩く（メールクライアントからの遷移と同じ形）。 */
async function callAction(
  url: string,
  method: "GET" | "POST" = "GET",
  ip = "203.0.113.9",
): Promise<{ status: number; html: string }> {
  // Token creation uses NOW; verification must observe the same test clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  try {
    const res = await handleAction(
      new Request(url, { method, headers: { "CF-Connecting-IP": ip } }),
      env,
    );
    return { status: res.status, html: await res.text() };
  } finally {
    vi.useRealTimers();
  }
}

describe("GET|POST /a/:token（SPEC §7.9）", () => {
  async function plannedQueue(suffix: string, mode: "cancel" | "manual" = "cancel") {
    const f = await fixture(suffix);
    await enableAp(f, { approvalMode: mode });
    await withAiMock(() => planAccount(makeJobContext(env, { now: NOW }), f.accountId));
    const row = await testDb().first<{ id: string; scheduled_at: string }>(
      "SELECT id, scheduled_at FROM queue WHERE account_id=? AND source='autopilot'",
      f.accountId,
    );
    return { f, queueId: row!.id, scheduledAt: row!.scheduled_at };
  }

  it("未連携ならメール承認を拒否し、再連携後までトークンを残す", async () => {
    const { f, queueId, scheduledAt } = await plannedQueue("act-disconnected", "manual");
    const url = await actionUrl(env, { queueId, action: "approve", scheduledAt, nowMs: NOW.getTime() });
    await testDb().run("UPDATE accounts SET status='needs_reauth' WHERE id=?", f.accountId);
    const denied = await callAction(url, "POST");
    expect(denied.status).toBe(409);
    const row = await testDb().first<{ status: string; action_token_used_at: string | null }>("SELECT status, action_token_used_at FROM queue WHERE id=?", queueId);
    expect(row?.status).toBe("pending_approval");
    expect(row?.action_token_used_at).toBeNull();
    await testDb().run("UPDATE accounts SET status='ok' WHERE id=?", f.accountId);
    expect((await callAction(url, "POST")).status).toBe(200);
  });

  it("GET は確認画面を返し、トークンを消費しない", async () => {
    const { f, queueId, scheduledAt } = await plannedQueue("act1");
    const url = await actionUrl(env, {
      queueId,
      action: "cancel",
      scheduledAt,
      nowMs: NOW.getTime(),
    });
    const got = await callAction(url, "GET");
    expect(got.status).toBe(200);
    expect(got.html).toContain("取り消しますか？");
    expect(got.html).toContain('method="post"');

    const row = await testDb().first<{ status: string; action_token_used_at: string | null }>(
      "SELECT status, action_token_used_at FROM queue WHERE id=?",
      queueId,
    );
    expect(row!.action_token_used_at).toBeNull();
    expect(row!.status).toBe("scheduled");
    expect(f.accountId).toBeTruthy();
  });

  it("POST で取消が1回だけ成立し、2回目は「すでに完了しています」（Cookie なし）", async () => {
    const { f, queueId, scheduledAt } = await plannedQueue("act2");
    const url = await actionUrl(env, {
      queueId,
      action: "cancel",
      scheduledAt,
      nowMs: NOW.getTime(),
    });

    const first = await callAction(url, "POST", "203.0.113.10");
    expect(first.status).toBe(200);
    expect(first.html).toContain("取り消しました");

    const db = testDb();
    const row = await db.first<{ status: string; action_token_used_at: string | null }>(
      "SELECT status, action_token_used_at FROM queue WHERE id=?",
      queueId,
    );
    expect(row!.status).toBe("cancelled");
    expect(row!.action_token_used_at).not.toBeNull();

    // ap_log に残る（SPEC §7.9-8）
    const log = await db.first<{ message: string }>(
      "SELECT message FROM ap_log WHERE account_id=? AND kind='cancel' ORDER BY at DESC LIMIT 1",
      f.accountId,
    );
    expect(log!.message).toContain("メールのリンクから取り消しました");
    const audit = await db.first<{ action: string }>(
      "SELECT action FROM audit_log WHERE action='queue.cancel.email' LIMIT 1",
    );
    expect(audit).toBeTruthy();

    const second = await callAction(url, "POST", "203.0.113.10");
    expect(second.status).toBe(200);
    expect(second.html).toContain("すでに完了しています");
  });

  it("POST で承認すると pending_approval → scheduled になる", async () => {
    const { queueId, scheduledAt } = await plannedQueue("act3", "manual");
    const url = await actionUrl(env, {
      queueId,
      action: "approve",
      scheduledAt,
      nowMs: NOW.getTime(),
    });
    const res = await callAction(url, "POST", "203.0.113.11");
    expect(res.html).toContain("承認しました");
    const row = await testDb().first<{ status: string; approve_deadline: string | null }>(
      "SELECT status, approve_deadline FROM queue WHERE id=?",
      queueId,
    );
    expect(row!.status).toBe("scheduled");
    expect(row!.approve_deadline).toBeNull();
  });

  it("publishing / done は遷移も消費もせず「もう投稿されています」", async () => {
    const { queueId, scheduledAt } = await plannedQueue("act4");
    await testDb().run("UPDATE queue SET status='done' WHERE id=?", queueId);
    const url = await actionUrl(env, {
      queueId,
      action: "cancel",
      scheduledAt,
      nowMs: NOW.getTime(),
    });
    const res = await callAction(url, "POST", "203.0.113.12");
    expect(res.status).toBe(200);
    expect(res.html).toContain("もう投稿されています");
    const row = await testDb().first<{ status: string; action_token_used_at: string | null }>(
      "SELECT status, action_token_used_at FROM queue WHERE id=?",
      queueId,
    );
    expect(row!.status).toBe("done");
    expect(row!.action_token_used_at).toBeNull(); // 消費していない
  });

  it("cancelled / failed は「すでに取り消されたか、投稿に失敗しています」", async () => {
    const { queueId, scheduledAt } = await plannedQueue("act5");
    await testDb().run("UPDATE queue SET status='failed' WHERE id=?", queueId);
    const url = await actionUrl(env, {
      queueId,
      action: "cancel",
      scheduledAt,
      nowMs: NOW.getTime(),
    });
    const res = await callAction(url, "POST", "203.0.113.13");
    expect(res.html).toContain("すでに取り消されたか");
  });

  it("署名が壊れていたら「有効期限が切れています」（どこで落ちたかは漏らさない）", async () => {
    const res = await callAction("https://test.local/a/abc.def", "POST", "203.0.113.14");
    expect(res.html).toContain("有効期限");
  });

  it("期限切れのトークンは通らない", async () => {
    const { queueId } = await plannedQueue("act6");
    const url = await actionUrl(env, {
      queueId,
      action: "cancel",
      scheduledAt: new Date(NOW.getTime() - 10 * 86_400_000).toISOString(),
      nowMs: NOW.getTime() - 10 * 86_400_000,
    });
    const res = await callAction(url, "POST", "203.0.113.15");
    expect(res.html).toContain("有効期限");
  });

  it("1分に20回を超えると弾く（action:<ip>。SPEC §5.1）", async () => {
    const { queueId, scheduledAt } = await plannedQueue("act7");
    const url = await actionUrl(env, {
      queueId,
      action: "cancel",
      scheduledAt,
      nowMs: NOW.getTime(),
    });
    const ip = "203.0.113.99";
    for (let i = 0; i < 20; i++) await callAction(url, "GET", ip);
    const blocked = await callAction(url, "GET", ip);
    expect(blocked.status).toBe(429);
    expect(blocked.html).toContain("しばらく待って");
  });
});

/* ═══ 期限後に投稿される（時刻を進める。SPEC §13 M6） ═══ */

describe("取消可モードの一巡（SPEC §13 M6 の完了条件）", () => {
  it("計画 → 通知 → 期限後に cron で投稿される", async () => {
    const f = await fixture("flow1");
    await enableAp(f, { approvalMode: "cancel", approvalWindowH: 4 });

    // 1. 計画
    await withAiMock(() => planAccount(makeJobContext(env, { now: NOW }), f.accountId));
    const db = testDb();
    const q = await db.first<{ id: string; scheduled_at: string; approve_deadline: string }>(
      "SELECT id, scheduled_at, approve_deadline FROM queue WHERE account_id=? AND source='autopilot'",
      f.accountId,
    );

    // 2. 締切に通知
    const notified = await notifyAccount(
      makeJobContext(env, { now: new Date(Date.parse(q!.approve_deadline) + 1000) }),
      f.accountId,
    );
    expect(notified.sent).toBe(1);

    // 3. 予定時刻を過ぎたら publish が拾う。ツリーのコメントは commentDelaySec（120秒）
    //    後の次の実行で出るので、5分の cron を模して時刻を進めながら回す
    let row = await db.first<{ status: string; result_ids_json: string }>(
      "SELECT status, result_ids_json FROM queue WHERE id=?",
      q!.id,
    );
    for (let i = 0; i < 6 && row!.status !== "done"; i++) {
      const at = new Date(Date.parse(q!.scheduled_at) + 60_000 + i * 300_000);
      await publishJob(makeJobContext(env, { now: at }), {
        id: `j${i}`,
        type: "publish",
        accountId: f.accountId,
        attempts: 0,
        state: {},
      });
      row = await db.first<{ status: string; result_ids_json: string }>(
        "SELECT status, result_ids_json FROM queue WHERE id=?",
        q!.id,
      );
    }
    expect(row!.status).toBe("done");
    expect(JSON.parse(row!.result_ids_json).length).toBeGreaterThan(0);
  });

  it("取り消したら投稿されず、ap_log に残る", async () => {
    const f = await fixture("flow2");
    await enableAp(f, { approvalMode: "cancel", approvalWindowH: 4 });
    await withAiMock(() => planAccount(makeJobContext(env, { now: NOW }), f.accountId));
    const db = testDb();
    const q = await db.first<{ id: string; scheduled_at: string }>(
      "SELECT id, scheduled_at FROM queue WHERE account_id=? AND source='autopilot'",
      f.accountId,
    );
    const url = await actionUrl(env, {
      queueId: q!.id,
      action: "cancel",
      scheduledAt: q!.scheduled_at,
      nowMs: NOW.getTime(),
    });
    await callAction(url, "POST", "203.0.113.20");

    const after = new Date(Date.parse(q!.scheduled_at) + 60_000);
    await publishJob(makeJobContext(env, { now: after }), {
      id: "j",
      type: "publish",
      accountId: f.accountId,
      attempts: 0,
      state: {},
    });
    const row = await db.first<{ status: string; result_ids_json: string }>(
      "SELECT status, result_ids_json FROM queue WHERE id=?",
      q!.id,
    );
    expect(row!.status).toBe("cancelled");
    expect(JSON.parse(row!.result_ids_json)).toEqual([]);
  });
});

/* ═══ /autopilot/next（SPEC §7.7。ApBar） ══════════ */

describe("GET /autopilot/next（SPEC §7.7）", () => {
  it("オフなら「オートパイロットはオフです」", async () => {
    const f = await fixture("next1");
    const res = await api("GET", `/api/accounts/${f.accountId}/autopilot/next`, {
      cookie: f.cookie,
    });
    expect(res.body.data.enabled).toBe(false);
    expect(res.body.data.summary).toContain("オフ");
    expect(res.body.data.item).toBeNull();
  });

  it("取消可モードなら締切つきの1行を返す", async () => {
    const f = await fixture("next2");
    await enableAp(f, { approvalMode: "cancel", approvalWindowH: 4 });
    await withAiMock(() => planAccount(makeJobContext(env, { now: NOW }), f.accountId));
    const res = await api("GET", `/api/accounts/${f.accountId}/autopilot/next`, {
      cookie: f.cookie,
    });
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.summary).toContain("まで取り消せます");
    expect(res.body.data.item.source).toBe("autopilot");
  });
});

/* ═══ 通知設定と Push（SPEC §7.8） ═════════════════ */

describe("/api/notifications と /api/push（SPEC §7.8）", () => {
  it("既定は email 有効・push 無効・8時、PUT で変えられる", async () => {
    const f = await fixture("nof1");
    const got = await api("GET", "/api/notifications", { cookie: f.cookie });
    expect(got.body.data.notifications).toEqual({
      emailEnabled: true,
      pushEnabled: false,
      digestHour: 8,
    });
    const put = await api("PUT", "/api/notifications", {
      cookie: f.cookie,
      body: { emailEnabled: false, digestHour: 21 },
    });
    expect(put.body.data.notifications.emailEnabled).toBe(false);
    expect(put.body.data.notifications.digestHour).toBe(21);
  });

  it("Push の購読は暗号化して入り、同じ端末で二重にならない", async () => {
    const f = await fixture("nof2");
    const body = {
      endpoint: "https://push.example.com/abc123",
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    };
    const a = await api("POST", "/api/push/subscribe", { cookie: f.cookie, body });
    expect(a.status).toBe(201);
    await api("POST", "/api/push/subscribe", { cookie: f.cookie, body });

    const rows = await testDb().all<{ json: string }>(
      "SELECT json FROM push_subscriptions WHERE user_id=?",
      f.userId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.json).not.toContain("push.example.com"); // 平文で残さない

    await api("DELETE", "/api/push/subscribe", { cookie: f.cookie, body: { endpoint: body.endpoint } });
    const after = await testDb().all("SELECT id FROM push_subscriptions WHERE user_id=?", f.userId);
    expect(after).toHaveLength(0);
  });
});

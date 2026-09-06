import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { api, countRows, insertAccount, mockToken, registerUser, testDb } from "./helpers";
import { enqueueJob, makeJobContext, runJobs } from "../src/lib/jobs";
import { resetMock } from "../src/mock/threads";

const NOW = new Date("2026-09-06T00:00:00.000Z");

beforeEach(() => {
  resetMock();
});

/* ── 小道具 ─────────────────────────────────────────── */

/** ユーザーとアカウントを1組だけ作る。テストごとに独立させる。 */
async function setup(suffix: string): Promise<{ cookie: string; accountId: string; userId: string }> {
  const u = await registerUser();
  const accountId = await insertAccount({ userId: u.userId, token: mockToken(suffix) });
  return { cookie: u.cookie, accountId, userId: u.userId };
}

type QueueOptions = {
  status?: string;
  scheduledAt?: string | null;
  comments?: string[];
  approveDeadline?: string | null;
  step?: number;
  resultIds?: string[];
  source?: string;
};

/** `queue` 行を直接作る（ルートを通さずに状態を作りたいとき）。 */
async function insertQueue(
  accountId: string,
  body: string,
  options: QueueOptions = {},
): Promise<string> {
  const db = testDb();
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await db.run(
    `INSERT INTO queue (id, account_id, status, scheduled_at, body, comments_json, image_url, reply_control,
        source, approval_mode, approve_deadline, notified_at, action_token_used_at, step, next_step_at,
        container_id, container_polls, result_ids_json, error, error_raw, attempts, tags_json,
        origin_post_id, source_ids_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,NULL,'everyone', ?, NULL, ?, NULL, NULL, ?, NULL, NULL, 0, ?, NULL, NULL, 0, '{}', NULL, '[]', ?,?)`,
    id,
    accountId,
    options.status ?? "draft",
    options.scheduledAt === undefined ? null : options.scheduledAt,
    body,
    JSON.stringify(options.comments ?? []),
    options.source ?? "manual",
    options.approveDeadline ?? null,
    options.step ?? 0,
    JSON.stringify(options.resultIds ?? []),
    nowIso,
    nowIso,
  );
  return id;
}

async function readQueue(id: string) {
  return testDb().first<{
    status: string;
    scheduled_at: string | null;
    next_step_at: string | null;
    approve_deadline: string | null;
    step: number;
    result_ids_json: string;
    body: string;
  }>(
    "SELECT status, scheduled_at, next_step_at, approve_deadline, step, result_ids_json, body FROM queue WHERE id=?",
    id,
  );
}

/** `posts` 行を直接作る（`done` の行に結合される数字を用意するため）。 */
async function insertPost(
  accountId: string,
  postId: string,
  metrics: { views: number; likes: number; clicks?: number },
): Promise<void> {
  await testDb().run(
    `INSERT INTO posts (account_id, id, root_id, is_reply, text, permalink, media_type, media_url,
        link_attachment_url, posted_at, views, likes, replies, reposts, quotes, shares, clicks,
        tags_json, source, deleted)
      VALUES (?,?,?,0,?,?, 'TEXT_POST', NULL, NULL, ?, ?,?, 0, 0, 0, 0, ?, '{}', 'manual', 0)`,
    accountId,
    postId,
    postId,
    "投稿済みの本文です。",
    `https://www.threads.net/@demo_test/post/${postId}`,
    new Date().toISOString(),
    metrics.views,
    metrics.likes,
    metrics.clicks ?? 0,
  );
}

/** Asia/Tokyo で見たときの「時」と曜日を取る（SPEC §9.3 の既定枠の確認用）。 */
function tokyoParts(iso: string): { hour: number; weekday: string } {
  const d = new Date(iso);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(d),
  );
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
  }).format(d);
  return { hour, weekday };
}

/** リンク6本の本文（SPEC §9.6 の上限は5本）。 */
const SIX_LINKS =
  "https://a.example.com https://b.example.com https://c.example.com " +
  "https://d.example.com https://e.example.com https://f.example.com";
const LINK_LIMIT_MESSAGE = "1投稿に入れられるリンクは5つまでです（いまは6つ）";

/* ── 作成の3経路（SPEC §7.4 / §12.3） ───────────────── */

describe("POST /api/accounts/:id/queue（SPEC §7.4）", () => {
  it("status:'now' は今の時刻で予約され、publish ジョブが積まれる（SPEC §7.4 / §12.3）", async () => {
    const { cookie, accountId } = await setup("qnow");
    const before = Date.now();
    const res = await api("POST", `/api/accounts/${accountId}/queue`, {
      cookie,
      body: { status: "now", body: "今すぐ出す投稿です。" },
    });
    expect(res.status).toBe(201);

    const item = res.body.data.item;
    expect(item.status).toBe("scheduled");
    const at = Date.parse(item.scheduledAt as string);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);

    // publish ジョブが積まれる（SPEC §8.3 の「待たせない」前倒し）
    expect(await countRows("jobs", "account_id=? AND type='publish'", accountId)).toBe(1);
  });

  it("status:'scheduled' は指定した未来の時刻で予約される（SPEC §7.4 / §12.3）", async () => {
    const { cookie, accountId } = await setup("qsched");
    const at = new Date(Date.now() + 6 * 3600_000).toISOString();
    const res = await api("POST", `/api/accounts/${accountId}/queue`, {
      cookie,
      body: { status: "scheduled", scheduledAt: at, body: "明日の朝に出す投稿です。" },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.item.status).toBe("scheduled");
    expect(Date.parse(res.body.data.item.scheduledAt as string)).toBe(Date.parse(at));

    const row = (await readQueue(res.body.data.item.id))!;
    expect(row.status).toBe("scheduled");
    expect(Date.parse(row.scheduled_at!)).toBe(Date.parse(at));
    expect(await countRows("jobs", "account_id=? AND type='publish'", accountId)).toBe(1);
  });

  it("status:'scheduled' で日時が無いと日本語エラーで 400（SPEC §7.4）", async () => {
    const { cookie, accountId } = await setup("qnoat");
    const res = await api("POST", `/api/accounts/${accountId}/queue`, {
      cookie,
      body: { status: "scheduled", body: "日時を忘れた投稿です。" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("投稿する日時を指定してください");
    expect(await countRows("queue", "account_id=?", accountId)).toBe(0);
  });

  it("status:'draft' は下書きのまま。publish ジョブは積まれない（SPEC §7.4）", async () => {
    const { cookie, accountId } = await setup("qdraft");
    const res = await api("POST", `/api/accounts/${accountId}/queue`, {
      cookie,
      body: { status: "draft", body: "あとで直す下書きです。" },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.item.status).toBe("draft");
    expect(res.body.data.item.scheduledAt).toBeNull();
    expect(await countRows("jobs", "account_id=? AND type='publish'", accountId)).toBe(0);
  });
});

/* ── おすすめ枠（SPEC §7.4 / §9.3） ─────────────────── */

describe("GET /api/accounts/:id/queue/suggest-slot（SPEC §7.4 / §9.3）", () => {
  it("{at, reason, n} を返し、at は未来・実績なしの理由が付く（SPEC §9.3）", async () => {
    const { cookie, accountId } = await setup("qslot1");
    const res = await api("GET", `/api/accounts/${accountId}/queue/suggest-slot`, { cookie });
    expect(res.status).toBe(200);

    const slot = res.body.data;
    expect(Object.keys(slot).sort()).toEqual(["at", "n", "reason"]);
    expect(Date.parse(slot.at as string)).toBeGreaterThan(Date.now());
    expect(slot.reason).toBe("実績がまだ足りないので既定の枠です");
    expect(slot.n).toBe(0);
  });

  it("既定枠は平日21時・土日12時（Asia/Tokyo、quiet_hours で 0〜6時は出ない）（SPEC §9.3）", async () => {
    const { cookie, accountId } = await setup("qslot2");
    const res = await api("GET", `/api/accounts/${accountId}/queue/suggest-slot`, { cookie });
    expect(res.status).toBe(200);

    const { hour, weekday } = tokyoParts(res.body.data.at as string);
    const isWeekend = weekday === "Sat" || weekday === "Sun";
    expect({ hour, isWeekend }).toEqual({ hour: isWeekend ? 12 : 21, isWeekend });
  });

  it("返ってきた at をそのまま status:'scheduled' に渡すと予約できる（SPEC §12.3 Create）", async () => {
    const { cookie, accountId } = await setup("qslot3");
    const slot = await api("GET", `/api/accounts/${accountId}/queue/suggest-slot`, { cookie });
    const at = slot.body.data.at as string;

    const res = await api("POST", `/api/accounts/${accountId}/queue`, {
      cookie,
      body: { status: "scheduled", scheduledAt: at, body: "おすすめ枠で出す投稿です。" },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.item.status).toBe("scheduled");
    expect(Date.parse(res.body.data.item.scheduledAt as string)).toBe(Date.parse(at));
  });
});

/* ── リンク5本の上限（SPEC §9.6） ───────────────────── */

describe("リンクの本数（SPEC §9.6）", () => {
  it("POST はリンク6本を日本語エラーで弾く（SPEC §9.6）", async () => {
    const { cookie, accountId } = await setup("qlink1");
    const res = await api("POST", `/api/accounts/${accountId}/queue`, {
      cookie,
      body: { status: "draft", body: SIX_LINKS },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(LINK_LIMIT_MESSAGE);
    expect(await countRows("queue", "account_id=?", accountId)).toBe(0);
  });

  it("PATCH もリンク6本を弾く（SPEC §9.6）", async () => {
    const { cookie, accountId } = await setup("qlink2");
    const qid = await insertQueue(accountId, "まだリンクは1本もありません。");

    const res = await api("PATCH", `/api/accounts/${accountId}/queue/${qid}`, {
      cookie,
      body: { body: SIX_LINKS },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(LINK_LIMIT_MESSAGE);

    // 本文は書き換わっていない
    const row = (await readQueue(qid))!;
    expect(row.body).toBe("まだリンクは1本もありません。");
  });
});

/* ── 一覧（SPEC §7.4） ──────────────────────────────── */

describe("GET /api/accounts/:id/queue（SPEC §7.4）", () => {
  it("status で絞り込める（SPEC §7.4）", async () => {
    const { cookie, accountId } = await setup("qlist1");
    const draftId = await insertQueue(accountId, "下書きの本文です。", { status: "draft" });
    const scheduledId = await insertQueue(accountId, "予約の本文です。", {
      status: "scheduled",
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const drafts = await api("GET", `/api/accounts/${accountId}/queue?status=draft`, { cookie });
    expect(drafts.status).toBe(200);
    expect(drafts.body.data.items.map((i: { id: string }) => i.id)).toEqual([draftId]);

    const scheduled = await api("GET", `/api/accounts/${accountId}/queue?status=scheduled`, {
      cookie,
    });
    expect(scheduled.body.data.items.map((i: { id: string }) => i.id)).toEqual([scheduledId]);

    // status 指定なしは全部
    const all = await api("GET", `/api/accounts/${accountId}/queue`, { cookie });
    expect(all.body.data.items.length).toBe(2);
  });

  it("done の行に posts の数字が結合される（SPEC §7.4）", async () => {
    const { cookie, accountId } = await setup("qlist2");
    const postId = "17800000000009001";
    await insertPost(accountId, postId, { views: 4200, likes: 130, clicks: 7 });
    const doneId = await insertQueue(accountId, "投稿済みの本文です。", {
      status: "done",
      resultIds: [postId, "17800000000009002"],
    });
    // 下書きには数字が付かない（結合するのは done だけ）
    await insertQueue(accountId, "下書きの本文です。", { status: "draft" });

    const res = await api("GET", `/api/accounts/${accountId}/queue`, { cookie });
    expect(res.status).toBe(200);
    const done = res.body.data.items.find((i: { id: string }) => i.id === doneId);
    expect(done.metrics.postId).toBe(postId); // result_ids の先頭
    expect(done.metrics.views).toBe(4200);
    expect(done.metrics.likes).toBe(130);
    expect(done.metrics.clicks).toBe(7);

    const draft = res.body.data.items.find((i: { id: string }) => i.id !== doneId);
    expect(draft.metrics).toBeNull();
  });
});

/* ── 編集（SPEC §7.4） ──────────────────────────────── */

describe("PATCH /api/accounts/:id/queue/:qid（SPEC §7.4）", () => {
  it("本文と日時を編集できる（SPEC §7.4）", async () => {
    const { cookie, accountId } = await setup("qpatch1");
    const qid = await insertQueue(accountId, "編集前の本文です。", {
      status: "scheduled",
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const at = new Date(Date.now() + 8 * 3600_000).toISOString();

    const res = await api("PATCH", `/api/accounts/${accountId}/queue/${qid}`, {
      cookie,
      body: { body: "編集後の本文です。", comments: ["1つ目のコメント。"], scheduledAt: at },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.item.body).toBe("編集後の本文です。");
    expect(res.body.data.item.comments).toEqual(["1つ目のコメント。"]);
    expect(Date.parse(res.body.data.item.scheduledAt as string)).toBe(Date.parse(at));
  });

  it("status:'scheduled' で下書き→予約になり、publish ジョブが積まれる（SPEC §7.4）", async () => {
    const { cookie, accountId } = await setup("qpatch2");
    const qid = await insertQueue(accountId, "下書きから予約にする本文です。");
    const at = new Date(Date.now() + 4 * 3600_000).toISOString();

    const res = await api("PATCH", `/api/accounts/${accountId}/queue/${qid}`, {
      cookie,
      body: { status: "scheduled", scheduledAt: at },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.item.status).toBe("scheduled");
    expect(await countRows("jobs", "account_id=? AND type='publish'", accountId)).toBe(1);
  });

  it("root が公開済みの failed を編集しても step を 0 に戻さない（SPEC §8.3 の二重投稿防止）", async () => {
    const { cookie, accountId } = await setup("qpatch4");
    const qid = await insertQueue(accountId, "コメント段で失敗した投稿です。", {
      status: "failed",
      step: 2,
      resultIds: ["17800000000000000001"],
      comments: ["直したいコメントです。"],
    });

    const res = await api("PATCH", `/api/accounts/${accountId}/queue/${qid}`, {
      cookie,
      body: { comments: ["直したコメントです。"] },
    });
    expect(res.status).toBe(200);
    const row = (await readQueue(qid))!;
    expect(row.step).toBe(2); // 0 に戻すと step 0 が root をもう1本作る
    expect(JSON.parse(row.result_ids_json)).toEqual(["17800000000000000001"]);
  });

  it("まだ公開していない failed の編集は step を 0 に戻す（作り直し）", async () => {
    const { cookie, accountId } = await setup("qpatch5");
    const qid = await insertQueue(accountId, "リンクが多すぎて失敗した投稿です。", {
      status: "failed",
      step: 0,
      resultIds: [],
    });
    await testDb().run("UPDATE queue SET step=1 WHERE id=?", qid);

    const res = await api("PATCH", `/api/accounts/${accountId}/queue/${qid}`, {
      cookie,
      body: { body: "直した本文です。" },
    });
    expect(res.status).toBe(200);
    expect((await readQueue(qid))!.step).toBe(0);
  });

  it("日時が無いまま予約にはできない（SPEC §7.4）", async () => {
    const { cookie, accountId } = await setup("qpatch3");
    const qid = await insertQueue(accountId, "日時のない下書きです。");

    const res = await api("PATCH", `/api/accounts/${accountId}/queue/${qid}`, {
      cookie,
      body: { status: "scheduled" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("投稿する日時を指定してください");
    expect((await readQueue(qid))!.status).toBe("draft");
  });
});

/* ── 複製（SPEC §7.4） ──────────────────────────────── */

describe("POST /api/accounts/:id/queue/:qid/duplicate（SPEC §7.4）", () => {
  it("下書きとして複製され、本文は同じで ID が別（SPEC §7.4）", async () => {
    const { cookie, accountId } = await setup("qdup");
    const qid = await insertQueue(accountId, "複製元の本文です。", {
      status: "scheduled",
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
      comments: ["複製されるコメント。"],
    });

    const res = await api("POST", `/api/accounts/${accountId}/queue/${qid}/duplicate`, {
      cookie,
      body: {},
    });
    expect(res.status).toBe(201);

    const item = res.body.data.item;
    expect(item.id).not.toBe(qid);
    expect(item.status).toBe("draft");
    expect(item.scheduledAt).toBeNull();
    expect(item.body).toBe("複製元の本文です。");
    expect(item.comments).toEqual(["複製されるコメント。"]);

    // 元の行はそのまま残る
    expect((await readQueue(qid))!.status).toBe("scheduled");
    expect(await countRows("queue", "account_id=?", accountId)).toBe(2);
  });
});

/* ── 今すぐ投稿（SPEC §7.4 / §8.3） ─────────────────── */

describe("POST /api/accounts/:id/queue/:qid/publish-now（SPEC §7.4）", () => {
  it("scheduled_at と next_step_at が now になり、step と result_ids は残る（SPEC §8.3 の二重投稿防止）", async () => {
    const { cookie, accountId } = await setup("qpubnow");
    const qid = await insertQueue(accountId, "失敗から再開する本文です。", {
      status: "failed",
      scheduledAt: new Date(Date.now() - 3600_000).toISOString(),
      step: 2,
      resultIds: ["17800000000009100"],
    });

    const before = Date.now();
    const res = await api("POST", `/api/accounts/${accountId}/queue/${qid}/publish-now`, {
      cookie,
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.data.item.status).toBe("scheduled");
    expect(res.body.data.item.step).toBe(2);
    expect(res.body.data.item.resultIds).toEqual(["17800000000009100"]);

    const row = (await readQueue(qid))!;
    const at = Date.parse(row.scheduled_at!);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(row.next_step_at).toBe(row.scheduled_at);
    expect(await countRows("jobs", "account_id=? AND type='publish'", accountId)).toBe(1);
  });
});

/* ── 削除（SPEC §7.4） ──────────────────────────────── */

describe("DELETE /api/accounts/:id/queue/:qid（SPEC §7.4）", () => {
  it("done 以外は消える（SPEC §7.4）", async () => {
    const { cookie, accountId } = await setup("qdel1");
    const qid = await insertQueue(accountId, "消される下書きです。");

    const res = await api("DELETE", `/api/accounts/${accountId}/queue/${qid}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
    expect(await countRows("queue", "id=?", qid)).toBe(0);
  });

  it("done は 409 で消せない（SPEC §7.4）", async () => {
    const { cookie, accountId } = await setup("qdel2");
    const qid = await insertQueue(accountId, "投稿済みの本文です。", {
      status: "done",
      resultIds: ["17800000000009200"],
    });

    const res = await api("DELETE", `/api/accounts/${accountId}/queue/${qid}`, { cookie });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(await countRows("queue", "id=?", qid)).toBe(1);
  });
});

/* ── 取消（SPEC §7.4） ──────────────────────────────── */

describe("POST /api/accounts/:id/queue/:qid/cancel（SPEC §7.4）", () => {
  it("status='cancelled' になり ap_log に1行残る（SPEC §7.4）", async () => {
    const { cookie, accountId } = await setup("qcancel");
    const qid = await insertQueue(accountId, "取り消す予約です。", {
      status: "scheduled",
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
      source: "autopilot",
    });

    const res = await api("POST", `/api/accounts/${accountId}/queue/${qid}/cancel`, {
      cookie,
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.data.item.status).toBe("cancelled");

    const row = (await readQueue(qid))!;
    expect(row.status).toBe("cancelled");
    expect(row.next_step_at).toBeNull();
    expect(await countRows("ap_log", "account_id=? AND ref_id=?", accountId, qid)).toBe(1);
  });
});

/* ── 承認（SPEC §7.4） ──────────────────────────────── */

describe("POST /api/accounts/:id/queue/:qid/approve（SPEC §7.4）", () => {
  it("pending_approval → scheduled になり approve_deadline が消える（SPEC §7.4）", async () => {
    const { cookie, accountId } = await setup("qapprove");
    const at = new Date(Date.now() + 5 * 3600_000).toISOString();
    const qid = await insertQueue(accountId, "承認待ちの本文です。", {
      status: "pending_approval",
      scheduledAt: at,
      approveDeadline: new Date(Date.now() + 3600_000).toISOString(),
      source: "autopilot",
    });

    const res = await api("POST", `/api/accounts/${accountId}/queue/${qid}/approve`, {
      cookie,
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.data.item.status).toBe("scheduled");
    expect(res.body.data.item.approveDeadline).toBeNull();

    const row = (await readQueue(qid))!;
    expect(row.status).toBe("scheduled");
    expect(row.approve_deadline).toBeNull();
    expect(Date.parse(row.scheduled_at!)).toBe(Date.parse(at));
    expect(await countRows("jobs", "account_id=? AND type='publish'", accountId)).toBe(1);
  });
});

/* ── 他人のアカウント（SPEC §7.4） ──────────────────── */

describe("キューは他人のアカウントを触れない（SPEC §7.4）", () => {
  it("アカウントIDを取るキュー系ルートは全部 404（SPEC §7.4）", async () => {
    const owner = await registerUser();
    const other = await registerUser();
    const accountId = await insertAccount({ userId: owner.userId, token: mockToken("qown") });
    const qid = await insertQueue(accountId, "本人だけが触れる下書きです。", {
      status: "pending_approval",
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const base = `/api/accounts/${accountId}/queue`;
    const routes: Array<[string, string, unknown?]> = [
      ["GET", base],
      ["GET", `${base}/suggest-slot`],
      ["POST", base, { status: "draft", body: "他人が作ろうとした下書き。" }],
      ["PATCH", `${base}/${qid}`, { body: "他人が書き換えようとした本文。" }],
      ["POST", `${base}/${qid}/approve`, {}],
      ["POST", `${base}/${qid}/cancel`, {}],
      ["POST", `${base}/${qid}/publish-now`, {}],
      ["POST", `${base}/${qid}/duplicate`, {}],
      ["DELETE", `${base}/${qid}`],
    ];

    for (const [method, path, body] of routes) {
      const r = await api(method, path, {
        cookie: other.cookie,
        ...(body === undefined ? {} : { body }),
      });
      expect({ method, path, status: r.status }).toEqual({ method, path, status: 404 });
    }

    // 本人の行は1件のまま、状態も本文も変わっていない
    expect(await countRows("queue", "account_id=?", accountId)).toBe(1);
    const row = (await readQueue(qid))!;
    expect(row.status).toBe("pending_approval");
    expect(row.body).toBe("本人だけが触れる下書きです。");
  });
});

/* ── リポスト（SPEC §7.3） ──────────────────────────── */

describe("POST /api/accounts/:id/posts/:postId/repost（SPEC §7.3）", () => {
  it("モックでリポストでき {id} が返る（SPEC §7.3 / §11）", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("qrepost") });

    // モックの投稿を DB に入れる（リポストは Threads 側にもある投稿だけを対象にする）
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "full_sync", { accountId, force: true });
    await runJobs(ctx);
    const post = (await testDb().first<{ id: string }>(
      "SELECT id FROM posts WHERE account_id=? AND is_reply=0 LIMIT 1",
      accountId,
    ))!;

    const res = await api("POST", `/api/accounts/${accountId}/posts/${post.id}/repost`, {
      cookie: u.cookie,
      body: {},
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.data.id).toBe("string");
    expect(res.body.data.id).not.toBe(post.id);
  });

  it("存在しない postId は 404（SPEC §7.3）", async () => {
    const { cookie, accountId } = await setup("qrepost404");
    const res = await api("POST", `/api/accounts/${accountId}/posts/17800000000000000/repost`, {
      cookie,
      body: {},
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { enqueueJob, makeJobContext, runJobs, type JobContext } from "../src/lib/jobs";
import { MAX_CONTAINER_POLLS, commentStep, publishJob } from "../src/jobs/publish";
import { resetMock } from "../src/mock/threads";
import { insertAccount, mockToken, registerUser, testDb } from "./helpers";

const NOW = new Date("2026-09-10T12:00:00.000Z");

beforeEach(() => {
  resetMock();
});

/** REPLY_TWO_STEP を切り替えた env を作る（SPEC §8.3「毎回 env を読んで解釈する」）。 */
function envWith(twoStep: boolean) {
  return { ...env, REPLY_TWO_STEP: twoStep ? "1" : "0" } as typeof env;
}

async function setup(suffix: string, options: { twoStep?: boolean } = {}) {
  const u = await registerUser();
  const accountId = await insertAccount({ userId: u.userId, token: mockToken(suffix) });
  return { u, accountId, e: envWith(options.twoStep ?? false) };
}

type QueueOptions = {
  status?: string;
  scheduledAt?: string | null;
  comments?: string[];
  imageUrl?: string | null;
  source?: string;
  step?: number;
  resultIds?: string[];
};

async function insertQueue(
  accountId: string,
  body: string,
  options: QueueOptions = {},
): Promise<string> {
  const db = testDb();
  const id = crypto.randomUUID();
  const nowIso = NOW.toISOString();
  await db.run(
    `INSERT INTO queue (id, account_id, status, scheduled_at, body, comments_json, image_url, reply_control,
        source, approval_mode, approve_deadline, notified_at, action_token_used_at, step, next_step_at,
        container_id, container_polls, result_ids_json, error, error_raw, attempts, tags_json,
        origin_post_id, source_ids_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?, 'everyone', ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, 0, ?, NULL, NULL, 0, '{}', NULL, '[]', ?,?)`,
    id,
    accountId,
    options.status ?? "scheduled",
    options.scheduledAt === undefined ? nowIso : options.scheduledAt,
    body,
    JSON.stringify(options.comments ?? []),
    options.imageUrl ?? null,
    options.source ?? "manual",
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
    step: number;
    next_step_at: string | null;
    container_polls: number;
    result_ids_json: string;
    error: string | null;
    error_raw: string | null;
    attempts: number;
  }>(
    "SELECT status, step, next_step_at, container_polls, result_ids_json, error, error_raw, attempts FROM queue WHERE id=?",
    id,
  );
}

/**
 * publish を、進まなくなるまで（または `max` 回）繰り返す。
 * 1回ごとに `next_step_at` の分だけ論理時刻を進めるので、実時間は待たない。
 */
async function drain(
  e: typeof env,
  accountId: string,
  queueId: string,
  options: { max?: number; startAt?: Date } = {},
): Promise<{ runs: number; now: Date }> {
  let now = options.startAt ?? NOW;
  const max = options.max ?? 12;
  let runs = 0;
  for (let i = 0; i < max; i++) {
    const ctx: JobContext = makeJobContext(e, { now });
    await publishJob(ctx, { id: "job", type: "publish", accountId, attempts: 0, state: {} });
    runs++;
    const row = await readQueue(queueId);
    if (!row) break;
    if (row.status !== "scheduled" && row.status !== "publishing") break;
    // 次のステップの時刻まで論理時計を進める
    const next = row.next_step_at ? Date.parse(row.next_step_at) : now.getTime();
    now = new Date(Math.max(next, now.getTime() + 1000));
  }
  return { runs, now };
}

describe("publish（SPEC §8.3）", () => {
  it("テキスト単発が1ステップで done になり、posts に入る", async () => {
    const { accountId, e } = await setup("pub1");
    const qid = await insertQueue(accountId, "今日の投稿です。ここから始めます。");

    await drain(e, accountId, qid);

    const row = (await readQueue(qid))!;
    expect(row.status).toBe("done");
    const ids = JSON.parse(row.result_ids_json) as string[];
    expect(ids.length).toBe(1);

    const post = await testDb().first<{
      id: string;
      is_reply: number;
      source: string;
      queue_id: string;
      tags_json: string;
    }>("SELECT id, is_reply, source, queue_id, tags_json FROM posts WHERE account_id=? AND id=?", accountId, ids[0]!);
    expect(post?.is_reply).toBe(0);
    expect(post?.source).toBe("manual");
    expect(post?.queue_id).toBe(qid);
    // queue.tags_json が空だったので §9.1 のタグを組み立てて入れる
    expect((JSON.parse(post!.tags_json) as { hook?: string }).hook).toBeTruthy();
  });

  it("ツリーのコメントが reply_to_id で root にぶら下がる", async () => {
    const { accountId, e } = await setup("pub2");
    const qid = await insertQueue(accountId, "本文です。", {
      comments: ["コメント1です。", "コメント2です。"],
    });

    await drain(e, accountId, qid);

    const row = (await readQueue(qid))!;
    expect(row.status).toBe("done");
    const ids = JSON.parse(row.result_ids_json) as string[];
    expect(ids.length).toBe(3);

    const posts = await testDb().all<{ id: string; root_id: string; is_reply: number; text: string }>(
      "SELECT id, root_id, is_reply, text FROM posts WHERE account_id=? AND queue_id=? ORDER BY is_reply ASC, id ASC",
      accountId,
      qid,
    );
    expect(posts.length).toBe(3);
    for (const p of posts) expect(p.root_id).toBe(ids[0]);
    expect(posts.filter((p) => p.is_reply === 1).length).toBe(2);
  });

  it("REPLY_TWO_STEP=1 でも同じ結果になる（SPEC §8.3 の3ステップ方式）", async () => {
    const { accountId, e } = await setup("pub3", { twoStep: true });
    const qid = await insertQueue(accountId, "本文です。", {
      comments: ["コメント1です。", "コメント2です。"],
    });

    await drain(e, accountId, qid, { max: 20 });

    const row = (await readQueue(qid))!;
    expect(row.status).toBe("done");
    const ids = JSON.parse(row.result_ids_json) as string[];
    expect(ids.length).toBe(3);
    const posts = await testDb().all<{ is_reply: number; root_id: string }>(
      "SELECT is_reply, root_id FROM posts WHERE account_id=? AND queue_id=?",
      accountId,
      qid,
    );
    expect(posts.length).toBe(3);
    for (const p of posts) expect(p.root_id).toBe(ids[0]);
  });

  it("step 2 の失敗で二重投稿しない（root は1本のまま、再開は step 2 から）", async () => {
    const { accountId, e } = await setup("pub4");
    // コメント1が [[FAIL]] で必ず落ちる
    const qid = await insertQueue(accountId, "二重投稿しないことの確認です。", {
      comments: ["[[FAIL]] このコメントは失敗します。"],
    });

    const first = await drain(e, accountId, qid);
    const failed = (await readQueue(qid))!;
    expect(failed.status).toBe("failed");
    expect(failed.step).toBe(2);
    const idsAfterFail = JSON.parse(failed.result_ids_json) as string[];
    expect(idsAfterFail.length).toBe(1); // root だけ保存されている
    expect(failed.error).toContain("Threads");
    expect(failed.error_raw).toContain("#100");

    // 本文はそのまま、コメントだけ直して再開する（publish-now と同じ形の再開）
    await testDb().run(
      "UPDATE queue SET status='scheduled', comments_json=?, next_step_at=?, scheduled_at=? WHERE id=?",
      JSON.stringify(["直したコメントです。"]),
      first.now.toISOString(),
      first.now.toISOString(),
      qid,
    );

    await drain(e, accountId, qid, { startAt: first.now });

    const done = (await readQueue(qid))!;
    expect(done.status).toBe("done");
    const ids = JSON.parse(done.result_ids_json) as string[];
    // root は作り直されず、コメントが1本足されただけ
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(idsAfterFail[0]);

    const roots = await testDb().all<{ id: string }>(
      "SELECT id FROM posts WHERE account_id=? AND queue_id=? AND is_reply=0",
      accountId,
      qid,
    );
    expect(roots.length).toBe(1);
  });

  it("step 0 に戻された行でも root を作り直さない（二重投稿の最後の関門。SPEC §8.3）", async () => {
    const { accountId, e } = await setup("pub4b");
    // まず root だけを1本出して、実在する ID を手に入れる
    const seed = await insertQueue(accountId, "先に出しておく1本目の本文です。");
    await drain(e, accountId, seed);
    const rootId = (JSON.parse((await readQueue(seed))!.result_ids_json) as string[])[0]!;

    // root は公開済みなのに step だけ 0 に戻っている行（PATCH の取りこぼし等）
    const qid = await insertQueue(accountId, "rootは公開済みの本文です。", {
      comments: ["残りのコメントです。"],
      step: 0,
      resultIds: [rootId],
    });

    await drain(e, accountId, qid);

    const row = (await readQueue(qid))!;
    expect(row.status).toBe("done");
    const ids = JSON.parse(row.result_ids_json) as string[];
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(rootId); // root は作り直されていない
  });

  it("ツリーのコメント待ちの間は、別の予約が投稿間隔をすり抜けない（SPEC §8.3）", async () => {
    const { accountId, e } = await setup("pub4c");
    const tree = await insertQueue(accountId, "ツリーの1本目です。コメントを待ちます。", {
      comments: ["あとから出すコメントです。"],
    });
    const other = await insertQueue(accountId, "同じころに出そうとする別の投稿です。");

    // 1回目: 早い方（tree）の root だけ出て step 2 で待つ
    await publishJob(makeJobContext(e, { now: NOW }), {
      id: "j1",
      type: "publish",
      accountId,
      attempts: 0,
      state: {},
    });
    expect((await readQueue(tree))!.step).toBe(2);

    // 1分後: もう1本は minGapMin（既定30分）に阻まれる
    await publishJob(makeJobContext(e, { now: new Date(NOW.getTime() + 60_000) }), {
      id: "j2",
      type: "publish",
      accountId,
      attempts: 0,
      state: {},
    });
    const blocked = (await readQueue(other))!;
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toContain("分あける設定です");
    expect(JSON.parse(blocked.result_ids_json)).toEqual([]);
  });

  it("画像は コンテナ IN_PROGRESS → FINISHED → publish で done になる", async () => {
    const { accountId, e } = await setup("pub5");
    const qid = await insertQueue(accountId, "画像つきの投稿です。", {
      imageUrl: "https://example.com/pic.png",
    });

    await drain(e, accountId, qid);

    const row = (await readQueue(qid))!;
    expect(row.status).toBe("done");
    const ids = JSON.parse(row.result_ids_json) as string[];
    expect(ids.length).toBe(1);
    const post = await testDb().first<{ media_type: string; media_url: string | null }>(
      "SELECT media_type, media_url FROM posts WHERE account_id=? AND id=?",
      accountId,
      ids[0]!,
    );
    expect(post?.media_type).toBe("IMAGE");
    expect(post?.media_url).toBe("https://example.com/pic.png");
  });

  it("コンテナが終わらないと container_polls が 10 で failed になる", async () => {
    const { accountId, e } = await setup("pub6");
    const qid = await insertQueue(accountId, "終わらない画像の投稿です。", {
      imageUrl: "https://example.com/slow.png",
    });

    await drain(e, accountId, qid, { max: MAX_CONTAINER_POLLS + 5 });

    const row = (await readQueue(qid))!;
    expect(row.status).toBe("failed");
    expect(row.container_polls).toBe(MAX_CONTAINER_POLLS);
    expect(row.error).toContain("画像");
    expect(JSON.parse(row.result_ids_json)).toEqual([]);
  });

  it("レート制限（code 4）で next_step_at が後ろに倒れ、再試行で成功する", async () => {
    const { accountId, e } = await setup("pub7");
    const qid = await insertQueue(accountId, "[[RATE]] レート制限を1回だけ受けます。");

    // 1回目: code 4 で跳ね返る
    const ctx1 = makeJobContext(e, { now: NOW });
    await publishJob(ctx1, { id: "j", type: "publish", accountId, attempts: 0, state: {} });
    const held = (await readQueue(qid))!;
    expect(held.status).toBe("publishing");
    expect(held.step).toBe(0);
    expect(JSON.parse(held.result_ids_json)).toEqual([]);
    expect(Date.parse(held.next_step_at!)).toBeGreaterThan(NOW.getTime());
    expect(held.attempts).toBe(1);
    expect(held.error).toContain("混み合っています");

    // 倒した時刻まで進めると通る
    const later = new Date(Date.parse(held.next_step_at!));
    await drain(e, accountId, qid, { startAt: later });
    const done = (await readQueue(qid))!;
    expect(done.status).toBe("done");
    expect((JSON.parse(done.result_ids_json) as string[]).length).toBe(1);
  });

  it("リンク6本は日本語のエラーで failed になる（validatePost、SPEC §9.6）", async () => {
    const { accountId, e } = await setup("pub8");
    const body =
      "https://a.example.com https://b.example.com https://c.example.com " +
      "https://d.example.com https://e.example.com https://f.example.com";
    const qid = await insertQueue(accountId, body);

    await drain(e, accountId, qid);

    const row = (await readQueue(qid))!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("1投稿に入れられるリンクは5つまでです（いまは6つ）");
    expect(JSON.parse(row.result_ids_json)).toEqual([]);
  });

  it("直近30日に似た投稿があると failed になる（3-gram Jaccard 0.8）", async () => {
    const { accountId, e } = await setup("pub9");
    const body = "朝の30分だけで下書きを3本作る方法をまとめました。まずは机の上を片付けます。";
    await testDb().run(
      `INSERT INTO posts (account_id, id, root_id, is_reply, text, permalink, media_type, media_url,
          link_attachment_url, posted_at, tags_json, source, deleted)
        VALUES (?,?,?,0,?,NULL,'TEXT_POST',NULL,NULL,?, '{}', 'manual', 0)`,
      accountId,
      "prev-1",
      "prev-1",
      body,
      new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
    );
    const qid = await insertQueue(accountId, body + "！");

    await drain(e, accountId, qid);

    const row = (await readQueue(qid))!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("直近30日に似た内容の投稿があります");
  });

  it("1日の投稿上限に達していると failed になる", async () => {
    const { accountId, e } = await setup("pub10");
    await testDb().run(
      "UPDATE accounts SET settings_json=? WHERE id=?",
      JSON.stringify({ dailyPostLimit: 1, minGapMin: 0 }),
      accountId,
    );
    // 今日すでに1件 done がある
    await insertQueue(accountId, "今日すでに出した投稿です。", { status: "done" });
    const qid = await insertQueue(accountId, "上限に引っかかる2本目です。");

    await drain(e, accountId, qid);

    const row = (await readQueue(qid))!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("1日の投稿上限");
  });

  it("投稿間隔（minGapMin）を満たさないと failed になる", async () => {
    const { accountId, e } = await setup("pub11");
    await testDb().run(
      "UPDATE accounts SET settings_json=? WHERE id=?",
      JSON.stringify({ minGapMin: 30 }),
      accountId,
    );
    await testDb().run(
      `INSERT INTO posts (account_id, id, root_id, is_reply, text, permalink, media_type, media_url,
          link_attachment_url, posted_at, tags_json, source, deleted)
        VALUES (?,?,?,0,?,NULL,'TEXT_POST',NULL,NULL,?, '{}', 'manual', 0)`,
      accountId,
      "recent-1",
      "recent-1",
      "10分前に出した投稿です。",
      new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    );
    const qid = await insertQueue(accountId, "間隔が足りない投稿です。");

    await drain(e, accountId, qid);

    const row = (await readQueue(qid))!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("30分あける");
  });

  it("ライセンスが revoked なら投稿せず、オートパイロットを止める（SPEC §5.4）", async () => {
    const { u, accountId, e } = await setup("pub12");
    await testDb().run("UPDATE licenses SET status='revoked' WHERE id=?", u.licenseId);
    await testDb().run("UPDATE autopilot SET enabled=1 WHERE account_id=?", accountId);
    const qid = await insertQueue(accountId, "止まるはずの投稿です。");

    const ctx = makeJobContext(e, { now: NOW });
    await publishJob(ctx, { id: "j", type: "publish", accountId, attempts: 0, state: {} });

    const row = (await readQueue(qid))!;
    expect(row.status).toBe("scheduled");
    const ap = await testDb().first<{ enabled: number }>(
      "SELECT enabled FROM autopilot WHERE account_id=?",
      accountId,
    );
    expect(ap?.enabled).toBe(0);
    const log = await testDb().first<{ message: string }>(
      "SELECT message FROM ap_log WHERE account_id=?",
      accountId,
    );
    expect(log?.message).toContain("ライセンス");
  });

  it("5分ごとの cron が publish を積み、runJobs が最優先で処理する（SPEC §8.2）", async () => {
    const { accountId, e } = await setup("pub13");
    const qid = await insertQueue(accountId, "cron から出る投稿です。");

    const ctx = makeJobContext(e, { now: NOW });
    const { enqueueForCron } = await import("../src/lib/jobs");
    await enqueueForCron(ctx, "*/5 * * * *");
    const jobs = await testDb().all<{ type: string; priority: number }>(
      "SELECT type, priority FROM jobs WHERE account_id=?",
      accountId,
    );
    expect(jobs.some((j) => j.type === "publish" && j.priority === 1)).toBe(true);

    await runJobs(ctx);
    const row = (await readQueue(qid))!;
    expect(row.status).toBe("done");
  });

  it("時刻がまだ来ていない予約は拾わない", async () => {
    const { accountId, e } = await setup("pub14");
    const qid = await insertQueue(accountId, "まだ先の予約です。", {
      scheduledAt: new Date(NOW.getTime() + 3600_000).toISOString(),
    });
    const ctx = makeJobContext(e, { now: NOW });
    await publishJob(ctx, { id: "j", type: "publish", accountId, attempts: 0, state: {} });
    expect((await readQueue(qid))!.status).toBe("scheduled");
  });

  it("pending_approval は拾わない（承認待ちは publish の対象外。SPEC §8.3）", async () => {
    const { accountId, e } = await setup("pub15");
    const qid = await insertQueue(accountId, "承認待ちの下書きです。", {
      status: "pending_approval",
    });
    const ctx = makeJobContext(e, { now: NOW });
    await publishJob(ctx, { id: "j", type: "publish", accountId, attempts: 0, state: {} });
    expect((await readQueue(qid))!.status).toBe("pending_approval");
  });

  it("ジョブとして走らせても最優先で done になる", async () => {
    const { accountId, e } = await setup("pub16");
    const qid = await insertQueue(accountId, "ジョブ経由の投稿です。");
    const ctx = makeJobContext(e, { now: NOW });
    await enqueueJob(ctx, "publish", { accountId });
    const res = await runJobs(ctx);
    expect(res.failed).toBe(0);
    expect((await readQueue(qid))!.status).toBe("done");
  });
});

describe("commentStep（SPEC §8.3 のステップ解釈）", () => {
  it("1ステップ方式は step-2 がそのままコメントの添字", () => {
    expect(commentStep(2, false)).toEqual({ index: 0, phase: 0 });
    expect(commentStep(3, false)).toEqual({ index: 1, phase: 0 });
    expect(commentStep(5, false)).toEqual({ index: 3, phase: 0 });
  });

  it("3ステップ方式は i=floor((step-2)/3), phase=(step-2)%3", () => {
    expect(commentStep(2, true)).toEqual({ index: 0, phase: 0 });
    expect(commentStep(3, true)).toEqual({ index: 0, phase: 1 });
    expect(commentStep(4, true)).toEqual({ index: 0, phase: 2 });
    expect(commentStep(5, true)).toEqual({ index: 1, phase: 0 });
    expect(commentStep(7, true)).toEqual({ index: 1, phase: 2 });
  });
});

/**
 * キュー（SPEC §7.4）。アプリ内から操作するときの経路。
 * メールのリンクからの承認/取消は `GET|POST /a/:token`（§7.9、M6）。
 *
 * 作成・編集は必ず `validatePost()` を通す（SPEC §9.6「全経路で使う」）。
 * 書き込みの中身は `lib/queue-ops.ts`（Claude 連携の MCP ツールと同じ処理を通す）。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  ok,
  localDateKey,
  normalizePostingTimes,
  postingSlotsForDate,
  type QueueItem,
  type QueueSlotsResponse,
} from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { audit } from "../lib/audit";
import { canPublishAccount, loadOwnedAccount } from "../lib/accounts";
import { isValidScheduleDate, loadPostingSchedule, nextPostingSlot } from "../lib/posting-schedule";
import {
  attachMetrics,
  parseJsonArray,
  QUEUE_SELECT,
  toQueueItem,
  type QueueRow,
} from "../lib/queue";
import {
  cancelQueueItem,
  createQueueItem,
  deleteQueueItem,
  loadQueueRow,
  publishQueueItemNow,
  schedulePublish,
  updateQueueItem,
  type QueueOpsContext,
} from "../lib/queue-ops";

const REPLY_CONTROLS = ["everyone", "accounts_you_follow", "mentioned_only"] as const;

// 枚数・説明の長さは validatePost で日本語の理由つきで弾く。ここは形と大きさの上限だけ
const mediaSchema = z
  .array(z.array(z.object({ url: z.string().trim().min(1).max(2000), alt: z.string().max(4000).optional() })).max(20))
  .max(11);

const createSchema = z.object({
  status: z.enum(["draft", "scheduled", "now", "next_slot"]),
  idempotencyKey: z.string().min(8).max(80).optional(),
  reserveSlot: z.boolean().optional(),
  scheduledAt: z.string().min(1).optional(),
  body: z.string().max(4000),
  comments: z.array(z.string().max(4000)).max(10).optional(),
  media: mediaSchema.optional(),
  imageUrl: z.string().trim().url().max(2000).nullable().optional(),
  replyControl: z.enum(REPLY_CONTROLS).optional(),
  originPostId: z.string().max(64).nullable().optional(),
  sourceIds: z.array(z.string().max(64)).max(20).optional(),
});

const patchSchema = z.object({
  reserveSlot: z.boolean().optional(),
  body: z.string().max(4000).optional(),
  comments: z.array(z.string().max(4000)).max(10).optional(),
  scheduledAt: z.string().min(1).nullable().optional(),
  media: mediaSchema.optional(),
  imageUrl: z.string().trim().url().max(2000).nullable().optional(),
  replyControl: z.enum(REPLY_CONTROLS).optional(),
  status: z.enum(["draft", "scheduled", "next_slot"]).optional(),
});

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

async function loadRow(
  db: AppEnv["Variables"]["db"],
  accountId: string,
  qid: string,
): Promise<QueueRow | null> {
  return loadQueueRow(db, accountId, qid);
}

async function itemOf(
  db: AppEnv["Variables"]["db"],
  accountId: string,
  row: QueueRow,
): Promise<QueueItem> {
  const metrics = await attachMetrics(db, accountId, [row]);
  const rootId = parseJsonArray(row.result_ids_json)[0];
  return toQueueItem(row, rootId ? (metrics.get(rootId) ?? null) : null);
}

export function queueRoutes() {
  const r = new Hono<AppEnv>();

  /* ── 一覧（SPEC §7.4） ────────────────────────────── */
  r.get("/:id/queue", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const raw = (c.req.query("status") ?? "").trim();
    const wanted = raw === "" ? [] : raw.split(",").map((s) => s.trim()).filter(Boolean);
    const where = ["account_id=?"];
    const args: unknown[] = [account.id];
    if (wanted.length > 0) {
      where.push(`status IN (${wanted.map(() => "?").join(",")})`);
      args.push(...wanted);
    }
    const rows = await db.all<QueueRow>(
      `SELECT ${QUEUE_SELECT} FROM queue WHERE ${where.join(" AND ")}
         ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 200`,
      ...args,
    );
    const metrics = await attachMetrics(db, account.id, rows);
    const items = rows.map((row) => {
      const rootId = parseJsonArray(row.result_ids_json)[0];
      return toQueueItem(row, rootId ? (metrics.get(rootId) ?? null) : null);
    });
    return c.json(ok({ items }));
  });

  /* ── おすすめ枠（SPEC §7.4 / §9.3） ──────────────────
   * `/:id/queue/:qid` より先に置く。Hono は先に登録した方が勝つ。
   */
  r.get("/:id/queue/suggest-slot", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const slot = await nextPostingSlot(db, account);
    if (!slot) return fail("CONFLICT", "7日先まで空いている投稿枠がありません。投稿スロットを見直してください", 409);
    return c.json(ok({ at: slot.at, reason: "設定した投稿スロットの次の空き枠です", n: 0 }));
  });

  r.get("/:id/posting-schedule", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    return c.json(ok(await loadPostingSchedule(db, account)));
  });

  r.put("/:id/posting-schedule", async (c) => {
    const parsed = z.object({ times: z.unknown() }).safeParse(await readJson(c));
    const times = parsed.success ? normalizePostingTimes(parsed.data.times) : null;
    if (!times) return fail("BAD_REQUEST", "投稿時間はHH:mm形式で1〜10個、重複しないように設定してください", 400);
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    await db.run(`INSERT INTO posting_schedules (account_id, times_json, updated_at) VALUES (?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET times_json=excluded.times_json, updated_at=excluded.updated_at`,
      account.id, JSON.stringify(times), new Date().toISOString());
    return c.json(ok({ timezone: account.timezone, times }));
  });

  r.get("/:id/queue/slots", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const date = c.req.query("date") ?? localDateKey(Date.now(), account.timezone);
    if (!isValidScheduleDate(date, account.timezone)) return fail("BAD_REQUEST", "日付の形式が正しくありません", 400);
    const schedule = await loadPostingSchedule(db, account);
    const slots = postingSlotsForDate(date, schedule.times, account.timezone);
    // UTC±14h の日付境界を含む範囲を読み、最後はアカウントの日付で厳密に絞る。
    const center = Date.parse(`${date}T12:00:00Z`);
    const rows = (await db.all<QueueRow>(`SELECT ${QUEUE_SELECT} FROM queue WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? ORDER BY scheduled_at`,
      account.id, new Date(center - 36 * 3_600_000).toISOString(), new Date(center + 36 * 3_600_000).toISOString()))
      .filter((q) => q.scheduled_at && localDateKey(Date.parse(q.scheduled_at), account.timezone) === date);
    const reserved = await db.all<{ scheduled_at: string; queue_id: string | null }>(
      "SELECT scheduled_at, queue_id FROM posting_slot_reservations WHERE account_id=? AND scheduled_at>=? AND scheduled_at<?",
      account.id, new Date(center - 36 * 3_600_000).toISOString(), new Date(center + 36 * 3_600_000).toISOString());
    const metrics = await attachMetrics(db, account.id, rows);
    const items = rows.map((q) => toQueueItem(q, metrics.get(parseJsonArray(q.result_ids_json)[0] ?? "") ?? null));
    const slotAt = new Set(slots.map((s) => s.at));
    const data: QueueSlotsResponse = {
      date, timezone: account.timezone,
      slots: slots.map((s) => {
        const item = items.find((q) => q.scheduledAt === s.at && !["cancelled", "draft"].includes(q.status)) ?? null;
        return { ...s, item, skipped: !item && reserved.some((r) => r.scheduled_at === s.at) };
      }),
      unslotted: items.filter((q) => !slotAt.has(q.scheduledAt ?? "") && !["cancelled", "draft"].includes(q.status)),
    };
    return c.json(ok(data));
  });

  /* ── 作成（SPEC §7.4） ────────────────────────────── */
  r.post("/:id/queue", async (c) => {
    const parsed = createSchema.safeParse(await readJson(c));
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const res = await createQueueItem(opsOf(c), account, parsed.data);
    if (!res.ok) return fail(res.code, res.message, res.status);
    const item = await itemOf(db, account.id, res.value.row);
    return res.value.existing ? c.json(ok({ item })) : c.json(ok({ item }), 201);
  });

  /* ── 編集・日時変更（SPEC §7.4） ─────────────────── */
  r.patch("/:id/queue/:qid", async (c) => {
    const parsed = patchSchema.safeParse(await readJson(c));
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const res = await updateQueueItem(opsOf(c), account, c.req.param("qid"), parsed.data);
    if (!res.ok) return fail(res.code, res.message, res.status);
    return c.json(ok({ item: await itemOf(db, account.id, res.value) }));
  });

  /* ── 承認（SPEC §7.4） ────────────────────────────── */
  r.post("/:id/queue/:qid/approve", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const row = await loadRow(db, account.id, c.req.param("qid"));
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    if (!canPublishAccount(account)) return fail("CONFLICT", "Threads APIを設定で連携し直してから予約してください", 409);
    if (row.status !== "pending_approval" && row.status !== "scheduled") {
      return fail("CONFLICT", "この下書きは承認できる状態ではありません", 409);
    }
    if (!row.scheduled_at) return fail("BAD_REQUEST", "投稿する日時がありません", 400);

    const approved = await db.run(
      "UPDATE queue SET status='scheduled', approve_deadline=NULL, updated_at=? WHERE id=? AND account_id=? AND status=? AND updated_at=? AND status IN ('pending_approval','scheduled')",
      new Date().toISOString(), row.id, account.id, row.status, row.updated_at,
    );
    if (approved.changes === 0) return fail("CONFLICT", "別の操作で状態が変わりました。最新の状態を確認してください", 409);
    await schedulePublish(opsOf(c), account.id, row.scheduled_at);
    await audit(db, c.get("userId")!, "queue.approve", { accountId: account.id, queueId: row.id });
    const next = (await loadRow(db, account.id, row.id))!;
    return c.json(ok({ item: await itemOf(db, account.id, next) }));
  });

  /* ── 取消（SPEC §7.4） ────────────────────────────── */
  r.post("/:id/queue/:qid/cancel", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const res = await cancelQueueItem(opsOf(c), account, c.req.param("qid"), c.get("userId")!);
    if (!res.ok) return fail(res.code, res.message, res.status);
    return c.json(ok({ item: await itemOf(db, account.id, res.value) }));
  });

  /* ── 今すぐ投稿（SPEC §7.4） ──────────────────────── */
  r.post("/:id/queue/:qid/publish-now", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const res = await publishQueueItemNow(opsOf(c), account, c.req.param("qid"));
    if (!res.ok) return fail(res.code, res.message, res.status);
    return c.json(ok({ item: await itemOf(db, account.id, res.value) }));
  });

  /* ── 複製（SPEC §7.4） ────────────────────────────── */
  r.post("/:id/queue/:qid/duplicate", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const row = await loadRow(db, account.id, c.req.param("qid"));
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await db.run(
      `INSERT INTO queue (id, account_id, status, scheduled_at, body, comments_json, image_url, media_json, reply_control,
          source, approval_mode, approve_deadline, notified_at, action_token_used_at, step, next_step_at,
          container_id, container_polls, result_ids_json, error, error_raw, attempts, tags_json,
          origin_post_id, source_ids_json, created_at, updated_at)
        VALUES (?,?, 'draft', NULL, ?,?,?,?,?, 'manual', NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, '[]', NULL, NULL, 0, '{}', ?,?,?,?)`,
      id,
      account.id,
      row.body,
      row.comments_json,
      row.image_url,
      row.media_json,
      row.reply_control,
      row.origin_post_id,
      row.source_ids_json,
      nowIso,
      nowIso,
    );
    const next = (await loadRow(db, account.id, id))!;
    return c.json(ok({ item: await itemOf(db, account.id, next) }), 201);
  });

  /* ── 削除（`done` 以外。SPEC §7.4） ───────────────── */
  r.delete("/:id/queue/:qid", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);
    const res = await deleteQueueItem(db, account, c.req.param("qid"));
    if (!res.ok) return fail(res.code, res.message, res.status);
    return c.json(ok(res.value));
  });

  return r;
}

/** ルートの文脈から、キューの書き込み（lib/queue-ops.ts）に渡す文脈を作る */
function opsOf(c: Context<AppEnv>): QueueOpsContext {
  return { env: c.env, db: c.get("db"), budget: c.get("budget") };
}

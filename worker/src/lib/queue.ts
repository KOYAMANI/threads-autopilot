/**
 * `queue` テーブルの共通処理（SPEC §4 / §7.4 / §8.3）。
 * ルート（routes/queue.ts）と publish ジョブ（jobs/publish.ts）の両方から使う。
 */
import { similarity, type QueueItem, type QueueMetrics, type QueueStatus } from "@tap/shared";
import type { Db } from "./db";
import { parseSettings, type AccountRow } from "./accounts";

export type QueueRow = {
  id: string;
  account_id: string;
  status: string;
  scheduled_at: string | null;
  body: string;
  comments_json: string;
  image_url: string | null;
  reply_control: string;
  source: string;
  approval_mode: string | null;
  approve_deadline: string | null;
  notified_at: string | null;
  action_token_used_at: string | null;
  step: number;
  next_step_at: string | null;
  container_id: string | null;
  container_polls: number;
  result_ids_json: string;
  error: string | null;
  error_raw: string | null;
  attempts: number;
  tags_json: string;
  origin_post_id: string | null;
  source_ids_json: string;
  created_at: string;
  updated_at: string;
};

export const QUEUE_SELECT =
  "id, account_id, status, scheduled_at, body, comments_json, image_url, reply_control, source, " +
  "approval_mode, approve_deadline, notified_at, action_token_used_at, step, next_step_at, container_id, " +
  "container_polls, result_ids_json, error, error_raw, attempts, tags_json, origin_post_id, source_ids_json, " +
  "created_at, updated_at";

/** 画面に出しうる状態（SPEC §12.3 のタブ）。 */
export const QUEUE_STATUSES: QueueStatus[] = [
  "draft",
  "pending_approval",
  "scheduled",
  "publishing",
  "done",
  "failed",
  "cancelled",
];

export function parseJsonArray(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function toQueueItem(row: QueueRow, metrics: QueueMetrics | null = null): QueueItem {
  return {
    id: row.id,
    accountId: row.account_id,
    status: row.status as QueueStatus,
    scheduledAt: row.scheduled_at,
    body: row.body,
    comments: parseJsonArray(row.comments_json),
    imageUrl: row.image_url,
    replyControl: (row.reply_control as QueueItem["replyControl"]) ?? "everyone",
    source: (row.source as QueueItem["source"]) ?? "manual",
    approvalMode: (row.approval_mode as QueueItem["approvalMode"]) ?? null,
    approveDeadline: row.approve_deadline,
    step: row.step,
    containerPolls: row.container_polls,
    resultIds: parseJsonArray(row.result_ids_json),
    error: row.error,
    errorRaw: row.error_raw,
    attempts: row.attempts,
    originPostId: row.origin_post_id,
    sourceIds: parseJsonArray(row.source_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metrics,
  };
}

/**
 * `done` の行に `posts` の数字を結合する（SPEC §7.4）。
 * root は `result_ids[0]`。まだ数字が入っていなければ 0 のまま返す（次の `insights_recent` で入る）。
 */
export async function attachMetrics(
  db: Db,
  accountId: string,
  rows: QueueRow[],
): Promise<Map<string, QueueMetrics>> {
  const rootIds = rows
    .filter((r) => r.status === "done")
    .map((r) => parseJsonArray(r.result_ids_json)[0])
    .filter((x): x is string => typeof x === "string");
  const out = new Map<string, QueueMetrics>();
  if (rootIds.length === 0) return out;

  for (let i = 0; i < rootIds.length; i += 80) {
    const chunk = rootIds.slice(i, i + 80);
    const found = await db.all<{
      id: string;
      permalink: string | null;
      posted_at: string;
      views: number;
      likes: number;
      replies: number;
      reposts: number;
      quotes: number;
      shares: number;
      clicks: number;
    }>(
      `SELECT id, permalink, posted_at, views, likes, replies, reposts, quotes, shares, clicks
         FROM posts WHERE account_id=? AND id IN (${chunk.map(() => "?").join(",")})`,
      accountId,
      ...chunk,
    );
    for (const p of found) {
      out.set(p.id, {
        postId: p.id,
        permalink: p.permalink,
        postedAt: p.posted_at,
        views: p.views,
        likes: p.likes,
        replies: p.replies,
        reposts: p.reposts,
        quotes: p.quotes,
        shares: p.shares,
        clicks: p.clicks,
      });
    }
  }
  return out;
}

/* ── アカウント設定（SPEC §8.3 の直前チェック） ─────── */

/** SPEC §8.3 の既定値。`accounts.settings_json` で上書きできる。 */
export const DEFAULT_DAILY_POST_LIMIT = 20;
export const DEFAULT_MIN_GAP_MIN = 30;
export const DEFAULT_COMMENT_DELAY_SEC = 120;
/** 重複と見なす 3-gram Jaccard のしきい値（SPEC §8.3）。 */
export const DUPLICATE_THRESHOLD = 0.8;
/** 重複を見に行く期間（SPEC §8.3「直近30日」）。 */
export const DUPLICATE_WINDOW_DAYS = 30;

export type PublishSettings = {
  dailyPostLimit: number;
  minGapMin: number;
  commentDelaySec: number;
};

function positiveInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function publishSettings(account: AccountRow): PublishSettings {
  const s = parseSettings(account);
  return {
    dailyPostLimit: positiveInt(s.dailyPostLimit, DEFAULT_DAILY_POST_LIMIT),
    minGapMin: positiveInt(s.minGapMin, DEFAULT_MIN_GAP_MIN),
    commentDelaySec: positiveInt(s.commentDelaySec, DEFAULT_COMMENT_DELAY_SEC),
  };
}

/**
 * 直近30日の似た投稿を探す（SPEC §8.3）。
 * 比べる相手は `posts`（`deleted=0`）と `queue`（`scheduled|pending_approval`）。
 * `source='recycle'` は比較対象からも判定対象からも外す。
 */
export async function findDuplicate(
  db: Db,
  accountId: string,
  body: string,
  options: { nowMs: number; excludeQueueId?: string },
): Promise<{ text: string; score: number } | null> {
  const since = new Date(options.nowMs - DUPLICATE_WINDOW_DAYS * 86_400_000).toISOString();

  const posts = await db.all<{ text: string }>(
    "SELECT text FROM posts WHERE account_id=? AND deleted=0 AND is_reply=0 AND source<>'recycle' AND posted_at>=?",
    accountId,
    since,
  );
  const queued = await db.all<{ text: string }>(
    "SELECT body AS text FROM queue WHERE account_id=? AND source<>'recycle' AND status IN ('scheduled','pending_approval') AND id<>? AND created_at>=?",
    accountId,
    options.excludeQueueId ?? "",
    since,
  );

  for (const row of [...posts, ...queued]) {
    const score = similarity(body, row.text);
    if (score >= DUPLICATE_THRESHOLD) return { text: row.text, score };
  }
  return null;
}

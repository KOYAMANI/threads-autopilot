/**
 * `full_sync`（SPEC §8.4）。
 *
 * `/me/threads` を15ページまで取り、`posts` へ upsert（既存の数字は保持）。
 * 次に `/me/replies` から自分の投稿にぶら下がる自分の返信を取り込む。
 * `state_json = {phase, after, pages, seen}` で再開できる。
 * `REPOST_FACADE` は `deleted=1` にして画面に出さない。
 * 外部投稿にも §9.1 のタグを付ける（集計の母数を最初から確保するため）。
 * 本文に出てきたURLは `links` に自動追加する（SPEC §7.5）。
 */
import { buildTags, extractUrls, normalizeUrl } from "@tap/shared";
import { accountToken, loadAccount, type AccountRow } from "../lib/accounts";
import { BudgetExceeded } from "../lib/budget";
import { buildUpsertChunks } from "../lib/db";
import { enqueueJob, wakeAccountSync, type JobContext, type RunningJob } from "../lib/jobs";
import {
  getProfile,
  listReplies,
  listThreads,
  type CallOptions,
  type ThreadsMedia,
  type ThreadsPage,
} from "../lib/threads";

/** 1フェーズあたりの最大ページ数（SPEC §8.4「15ページまで」）。 */
export const MAX_PAGES = 15;
export const PAGE_SIZE = 100;

/** 進捗バーの分母。threads と replies の2フェーズ × MAX_PAGES（SPEC §7.1 の sync 進捗）。 */
export const SYNC_TOTAL_PAGES = MAX_PAGES * 2;

type SyncState = {
  phase?: "threads" | "replies";
  after?: string | null;
  pages?: number;
  seen?: number;
  profileSynced?: boolean;
  imported?: boolean;
  previewScheduled?: boolean;
};

const POST_COLUMNS = [
  "account_id",
  "id",
  "root_id",
  "is_reply",
  "text",
  "permalink",
  "media_type",
  "media_url",
  "link_attachment_url",
  "posted_at",
  "tags_json",
  "source",
  "deleted",
];

/**
 * 既存行を上書きしてよい列だけ並べる。数字（views 等）・`clicks`・`metrics_fetched_at`・
 * `source`・`queue_id` は触らない（SPEC §8.4「既存の数字は保持」）。
 * `tags_json` は未設定のときだけ入れる。採点済みの `scored` を潰さないため（SPEC §9.2）。
 */
const POST_UPDATES = [
  "root_id",
  "is_reply",
  "text",
  "permalink",
  "media_type",
  "media_url",
  "link_attachment_url",
  "posted_at",
  "deleted",
  {
    column: "tags_json",
    expr: "CASE WHEN posts.tags_json='{}' THEN excluded.tags_json ELSE posts.tags_json END",
  },
];

export function mediaToRow(
  accountId: string,
  m: ThreadsMedia,
  tz: string,
  fallbackNow: string,
): unknown[] {
  const text = m.text ?? "";
  const postedAt = m.timestamp ?? fallbackNow;
  const isReply = m.is_reply ? 1 : 0;
  const rootId = m.root_post?.id ?? (isReply ? (m.replied_to?.id ?? m.id) : m.id);
  const mediaType = m.media_type ?? "TEXT_POST";
  return [
    accountId,
    m.id,
    rootId,
    isReply,
    text,
    m.permalink ?? null,
    mediaType,
    m.media_url ?? null,
    m.link_attachment_url ?? null,
    postedAt,
    JSON.stringify(buildTags(text, postedAt, tz)),
    "external",
    mediaType === "REPOST_FACADE" ? 1 : 0,
  ];
}

/** 本文に出てきたURLを `links` に自動追加する（SPEC §7.5）。既存はそのまま。 */
async function upsertFoundLinks(
  ctx: JobContext,
  accountId: string,
  texts: string[],
): Promise<void> {
  const urls = new Set<string>();
  for (const t of texts) {
    for (const raw of extractUrls(t)) {
      const url = normalizeUrl(raw);
      if (url !== "") urls.add(url);
    }
  }
  if (urls.size === 0) return;
  const nowIso = ctx.now.toISOString();
  // One bound JSON parameter avoids a page with many URLs exceeding the D1 query budget.
  await ctx.db.run(
    `INSERT INTO links(id,account_id,url,label,kind,enabled_for_ap,created_at)
     SELECT lower(hex(randomblob(16))),?,value,value,'other',1,? FROM json_each(?) WHERE 1
     ON CONFLICT(account_id,url) DO NOTHING`, accountId, nowIso, JSON.stringify([...urls]),
  );
}

async function savePage(
  ctx: JobContext,
  account: AccountRow,
  media: ThreadsMedia[],
): Promise<void> {
  if (media.length === 0) return;
  const nowIso = ctx.now.toISOString();
  const rows = media.map((m) => mediaToRow(account.id, m, account.timezone, nowIso));
  await ctx.db.batch(
    buildUpsertChunks("posts", POST_COLUMNS, rows, ["account_id", "id"], POST_UPDATES),
  );
  await upsertFoundLinks(
    ctx,
    account.id,
    media.map((m) => m.text ?? ""),
  );
}

/** `/me/replies` のうち、root が自分の投稿であるものだけ採用する（SPEC §6.3）。 */
async function keepOwnReplies(
  ctx: JobContext,
  accountId: string,
  media: ThreadsMedia[],
): Promise<ThreadsMedia[]> {
  const rootIds = [...new Set(media.map((m) => m.root_post?.id).filter((x): x is string => !!x))];
  if (rootIds.length === 0) return [];
  const found = new Set<string>();
  // IN 句のバインド数を100以内に収める
  for (let i = 0; i < rootIds.length; i += 90) {
    const chunk = rootIds.slice(i, i + 90);
    const rows = await ctx.db.all<{ id: string }>(
      `SELECT id FROM posts WHERE account_id=? AND id IN (${chunk.map(() => "?").join(",")})`,
      accountId,
      ...chunk,
    );
    for (const r of rows) found.add(r.id);
  }
  return media.filter((m) => m.root_post?.id && found.has(m.root_post.id));
}

export async function fullSyncJob(ctx: JobContext, job: RunningJob): Promise<void> {
  if (!job.accountId) return;
  const account = await ctx.db.first<AccountRow>(
    "SELECT id, user_id, threads_user_id, username, name, avatar_url, color, token_enc, token_obtained_at, token_long_lived, token_last_refresh_at, status, timezone, settings_json, last_full_sync_at, created_at FROM accounts WHERE id=?",
    job.accountId,
  );
  if (!account || account.status !== "ok") return;

  const token = await accountToken(ctx.env, account);
  const options: CallOptions = { budget: ctx.budget, env: ctx.env, now: ctx.now.getTime() };

  const free = ctx.env.WORKERS_PLAN === "free";
  const pageSize = free ? 25 : PAGE_SIZE;
  const pageProgress = pageSize / PAGE_SIZE;
  const state = job.state as SyncState;
  state.phase ??= "threads";
  state.pages ??= 0;
  state.seen ??= 0;

  if (!state.profileSynced) {
    const profile = await getProfile(token, options);
    await ctx.db.run("UPDATE accounts SET username=?,name=?,avatar_url=? WHERE id=?", profile.username, profile.name ?? null, profile.threads_profile_picture_url ?? null, account.id);
    state.profileSynced = true;
  }

  while (!state.imported && state.phase === "threads" && (state.pages ?? 0) < MAX_PAGES) {
    ctx.budget.timeMs.check();
    const page: ThreadsPage = await listThreads(
      token,
      { limit: pageSize, ...(state.after ? { after: state.after } : {}) },
      options,
    );
    await savePage(ctx, account, page.data ?? []);
    if (!state.previewScheduled) {
      for (const type of ["insights_recent", "insights_daily"] as const) {
        await enqueueJob(ctx, type, {accountId: account.id, state:{initial:true}});
      }
      await wakeAccountSync(ctx, account.id);
      state.previewScheduled = true;
    }
    state.pages = (state.pages ?? 0) + pageProgress;
    state.seen = (state.seen ?? 0) + (page.data?.length ?? 0);
    const after = page.paging?.cursors?.after;
    if (!after || (page.data?.length ?? 0) === 0) break;
    state.after = after;
    if (free) throw new BudgetExceeded("subrequests", 1, 1);
  }

  if (!state.imported && state.phase === "threads") {
    state.phase = "replies";
    state.after = null;
    state.pages = MAX_PAGES; // 進捗の分母を揃える（threads フェーズは終わり）
    if (free) throw new BudgetExceeded("subrequests", 1, 1);
  }

  if (!state.previewScheduled && (state.seen ?? 0) > 0) {
    for (const type of ["insights_recent", "insights_daily"] as const) {
      await enqueueJob(ctx, type, {accountId: account.id, state:{initial:true}});
    }
    await wakeAccountSync(ctx, account.id);
    state.previewScheduled = true;
  }
  let replyPages = 0;
  while (!state.imported && (state.pages ?? 0) < SYNC_TOTAL_PAGES && replyPages < MAX_PAGES) {
    ctx.budget.timeMs.check();
    const page: ThreadsPage = await listReplies(
      token,
      { limit: pageSize, ...(state.after ? { after: state.after } : {}) },
      options,
    );
    const mine = await keepOwnReplies(ctx, account.id, page.data ?? []);
    await savePage(ctx, account, mine);
    state.pages = (state.pages ?? 0) + pageProgress;
    replyPages++;
    state.seen = (state.seen ?? 0) + mine.length;
    const after = page.paging?.cursors?.after;
    if (!after || (page.data?.length ?? 0) === 0) break;
    state.after = after;
    if (free) throw new BudgetExceeded("subrequests", 1, 1);
  }

  state.imported = true;
  state.pages = SYNC_TOTAL_PAGES;
  state.phase = "replies";
  await ctx.db.run(
    "UPDATE accounts SET last_full_sync_at=? WHERE id=?",
    ctx.now.toISOString(),
    account.id,
  );
  for (const type of ["insights_recent", "insights_daily", "insights_old"] as const) {
    await enqueueJob(ctx, type, {accountId: account.id, state:{initial: true}});
  }
  await wakeAccountSync(ctx, account.id);
}

/**
 * `ap_score`（日次。SPEC §9.2）。
 *
 * 投稿から48時間以上経った root 投稿を採点し、`learning` を4次元（hook / slot / length /
 * source）で積み増す。**AI は使わない**。使う数字は `post_metrics_history` の
 * `checkpoint='48h'` の行で、`posts` の現在値ではない（古い投稿ほど伸びて有利になる
 * 比較のゆがみを避けるため）。
 *
 * - `checkpoint='48h'` の行が無い投稿は採点しない（`tags_json.scored` を付けずに次回へ）
 * - 分布はジョブの冒頭で1回だけ作り、投稿ごとには二分探索で順位を引く
 * - 分布の母数が10本未満のときは採点を見送る
 * - 採点は48時間の1回だけ。7日後の再採点はしない
 */
import {
  DISTRIBUTION_DAYS,
  MIN_DISTRIBUTION,
  SCORE_AFTER_HOURS,
  classifyHook,
  lengthBucket,
  scorePost,
  scoreWeightsOf,
  slotValue,
} from "@tap/shared";
import type { JobContext, RunningJob } from "../lib/jobs";
import { loadAutopilot } from "../lib/autopilot";

/** 1回の実行で採点する上限（暴走ガード）。残りは次の日次で拾う。 */
export const MAX_SCORED_PER_RUN = 300;

type ScoreRow = {
  id: string;
  text: string;
  posted_at: string;
  tags_json: string;
  clicks: number;
  link_attachment_url: string | null;
  h_views: number | null;
  h_likes: number | null;
};

type Distribution = { views: number[]; likeRate: number[] };

/** 直近180日の 48h 断面から分布を作る（SPEC §9.2）。冒頭で1回だけ。 */
export async function loadDistribution(
  ctx: JobContext,
  accountId: string,
): Promise<Distribution> {
  const since = new Date(
    ctx.now.getTime() - DISTRIBUTION_DAYS * 86_400_000,
  ).toISOString();
  const rows = await ctx.db.all<{ views: number; likes: number }>(
    `SELECT h.views AS views, h.likes AS likes
       FROM post_metrics_history h JOIN posts p ON p.account_id=h.account_id AND p.id=h.post_id
      WHERE h.account_id=? AND h.checkpoint='48h' AND p.is_reply=0 AND p.deleted=0
        AND p.posted_at>=?`,
    accountId,
    since,
  );
  const views: number[] = [];
  const likeRate: number[] = [];
  for (const r of rows) {
    const v = r.views ?? 0;
    views.push(v);
    if (v > 0) likeRate.push((r.likes ?? 0) / v); // V=0 は除外（SPEC §9.2）
  }
  views.sort((a, b) => a - b);
  likeRate.sort((a, b) => a - b);
  return { views, likeRate };
}

/** 採点対象。48h 経過・未採点の root 投稿。48h 行はここで LEFT JOIN して見る。 */
async function loadTargets(ctx: JobContext, accountId: string): Promise<ScoreRow[]> {
  const cutoff = new Date(
    ctx.now.getTime() - SCORE_AFTER_HOURS * 3_600_000,
  ).toISOString();
  return ctx.db.all<ScoreRow>(
    `SELECT p.id AS id, p.text AS text, p.posted_at AS posted_at, p.tags_json AS tags_json,
            p.clicks AS clicks, p.link_attachment_url AS link_attachment_url,
            h.views AS h_views, h.likes AS h_likes
       FROM posts p
       LEFT JOIN post_metrics_history h
         ON h.account_id=p.account_id AND h.post_id=p.id AND h.checkpoint='48h'
      WHERE p.account_id=? AND p.is_reply=0 AND p.deleted=0 AND p.posted_at<=?
        AND p.tags_json NOT LIKE '%"scored"%'
      ORDER BY p.posted_at ASC
      LIMIT ?`,
    accountId,
    cutoff,
    MAX_SCORED_PER_RUN,
  );
}

function parseTags(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export type ScoreSummary = { scored: number; skipped: number; reason: string | null };

/**
 * 1アカウントを採点する。ジョブ本体とテストの両方から呼ぶ。
 * 予算切れは `BudgetExceeded` がそのまま上に抜け、次回続きから走る（採点済みの行は
 * `tags_json.scored` が付いているので二重に数えない）。
 */
export async function scoreAccount(
  ctx: JobContext,
  accountId: string,
): Promise<ScoreSummary> {
  const ap = await loadAutopilot(ctx.db, accountId);
  const weights = scoreWeightsOf(ap.score_weights);

  const dist = await loadDistribution(ctx, accountId);
  if (dist.views.length < MIN_DISTRIBUTION) {
    // 順位が意味を持たないので採点を見送る（SPEC §9.2）。scored は付けない
    return { scored: 0, skipped: 0, reason: `分布の母数が${dist.views.length}本で足りません` };
  }

  const targets = await loadTargets(ctx, accountId);
  const account = await ctx.db.first<{ timezone: string }>(
    "SELECT timezone FROM accounts WHERE id=?",
    accountId,
  );
  const tz = account?.timezone ?? "Asia/Tokyo";

  let scored = 0;
  let skipped = 0;

  for (const row of targets) {
    ctx.budget.timeMs.check();

    // 48h 行が無い投稿は採点しない。scored も付けず、次の日次で拾い直す（SPEC §9.2）
    if (row.h_views === null) {
      skipped++;
      continue;
    }

    const child = await ctx.db.first<{ views: number }>(
      `SELECT views FROM posts
         WHERE account_id=? AND root_id=? AND is_reply=1 AND deleted=0
         ORDER BY posted_at ASC LIMIT 1`,
      accountId,
      row.id,
    );

    const tags = parseTags(row.tags_json);
    const hook = typeof tags.hook === "string" ? tags.hook : classifyHook(row.text);
    const slot = typeof tags.slot === "string" && typeof tags.daytype === "string"
      ? `${tags.daytype}-${tags.slot}`
      : slotValue(row.posted_at, tz);
    const length = typeof tags.length === "string" ? tags.length : lengthBucket(row.text);
    const sourceId = typeof tags.source_id === "string" && tags.source_id !== ""
      ? tags.source_id
      : "external";
    const hasLink =
      Boolean(row.link_attachment_url) || typeof tags.link === "string" || row.clicks > 0;

    const V = row.h_views ?? 0;
    const L = row.h_likes ?? 0;
    const result = scorePost({
      views: V,
      likes: L,
      firstChildViews: child ? child.views : null,
      clicks: hasLink ? row.clicks : null,
      viewsDist: dist.views,
      likeRateDist: dist.likeRate,
      weights,
    });

    const likeRate = V > 0 ? L / V : 0;
    const nowIso = ctx.now.toISOString();
    // 4次元を1クエリでまとめて積む（D1 のクエリ予算を食わないため。SPEC §8.1）
    await ctx.db.run(
      `INSERT INTO learning (account_id, dim, value, n, score_sum, views_sum, like_rate_sum, updated_at)
         VALUES (?,?,?,1,?,?,?,?),(?,?,?,1,?,?,?,?),(?,?,?,1,?,?,?,?),(?,?,?,1,?,?,?,?)
         ON CONFLICT(account_id, dim, value) DO UPDATE SET
           n = n + 1,
           score_sum = score_sum + excluded.score_sum,
           views_sum = views_sum + excluded.views_sum,
           like_rate_sum = like_rate_sum + excluded.like_rate_sum,
           updated_at = excluded.updated_at`,
      accountId, "hook", hook, result.score, V, likeRate, nowIso,
      accountId, "slot", slot, result.score, V, likeRate, nowIso,
      accountId, "length", length, result.score, V, likeRate, nowIso,
      accountId, "source", sourceId, result.score, V, likeRate, nowIso,
    );

    tags.scored = true;
    tags.score = Math.round(result.score * 1000) / 1000;
    tags.hook = hook;
    tags.length = length;
    await ctx.db.run(
      "UPDATE posts SET tags_json=? WHERE account_id=? AND id=?",
      JSON.stringify(tags),
      accountId,
      row.id,
    );
    scored++;
  }

  return { scored, skipped, reason: null };
}

/** ジョブ本体（`jobs/registry.ts` から呼ばれる）。 */
export async function apScoreJob(ctx: JobContext, job: RunningJob): Promise<void> {
  if (!job.accountId) return;
  const summary = await scoreAccount(ctx, job.accountId);
  job.state.scored = summary.scored;
  job.state.skipped = summary.skipped;
  if (summary.reason) job.state.reason = summary.reason;
}

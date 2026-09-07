/**
 * `daily_digest`（毎時。SPEC §4 の `notifications.digest_hour` を実際に使う、M7）。
 *
 * 前日の「投稿数・数字・失敗」をメールで1通送る。ジョブは**毎時**動き、
 * 買い手ごとに「そのアカウントの timezone でいまが `digest_hour` か」を見て送る。
 * cron を時刻ごとに分けないのは、買い手ごとに時刻が違うし timezone も違うため。
 *
 * 二重送信を止めるのは `notifications.last_digest_date`（アカウント timezone の日付）。
 * 毎時の cron が同じ時刻帯を2回踏んでも、その日ぶんはもう入っているので送らない。
 *
 * ダイジェストは**メールだけ**。承認・取消のように急ぐものではないので Push は出さない
 * （Push は `ap_notify` の側。DECISIONS 2026-09-06）。
 */
import { BudgetExceeded } from "../lib/budget";
import type { JobContext, RunningJob } from "../lib/jobs";
import { sendEmail } from "../lib/email";
import { notifyTargetForUser } from "../lib/notify";

/** 1回の実行で送る上限（暴走ガード）。残りは次の毎時で拾う。 */
export const MAX_DIGEST_PER_RUN = 20;

type DigestUser = {
  user_id: string;
  digest_hour: number;
  last_digest_date: string | null;
  email_enabled: number | null;
};

/** そのアカウントの timezone での `YYYY-MM-DD` と「時」。 */
export function tzDateAndHour(now: Date, tz: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")) % 24,
  };
}

/** 前日の 00:00〜24:00 を、その timezone で UTC の ISO 範囲に直す。 */
export function previousDayRange(now: Date, tz: string): { from: string; to: string; label: string } {
  const today = tzDateAndHour(now, tz).date;
  const todayStartMs = Date.parse(`${today}T00:00:00Z`);
  // tz の「今日の0時」を UTC ms にする。オフセットは now と今日0時で同じとみなす
  // （DST の切り替わり日でも、ダイジェストの範囲が1時間ずれるだけで害はない）
  const offsetMs = tzOffsetMs(now, tz);
  const todayStartUtc = todayStartMs - offsetMs;
  const yesterdayStartUtc = todayStartUtc - 86_400_000;
  const label = new Date(yesterdayStartUtc + offsetMs).toISOString().slice(0, 10);
  return {
    from: new Date(yesterdayStartUtc).toISOString(),
    to: new Date(todayStartUtc).toISOString(),
    label,
  };
}

/** tz の壁時計 − UTC（ミリ秒）。 */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export type DigestSummary = { sent: number; skipped: number };

/**
 * 1人ぶんの本文を組み立てる。アカウントごとに1行。
 * 「投稿はありませんでした」しか書けないときも送る — 「昨日は動かなかった」も情報なので。
 */
async function buildBody(
  ctx: JobContext,
  userId: string,
  tz: string,
): Promise<{ date: string; lines: string; failures: string } | null> {
  const range = previousDayRange(ctx.now, tz);
  const rows = await ctx.db.all<{
    username: string;
    n: number;
    views: number;
    likes: number;
    clicks: number;
  }>(
    `SELECT a.username AS username, COUNT(p.id) AS n,
            COALESCE(SUM(p.views),0) AS views, COALESCE(SUM(p.likes),0) AS likes,
            COALESCE(SUM(p.clicks),0) AS clicks
       FROM accounts a LEFT JOIN posts p
         ON p.account_id=a.id AND p.is_reply=0 AND p.deleted=0
        AND p.posted_at>=? AND p.posted_at<?
      WHERE a.user_id=?
      GROUP BY a.id ORDER BY a.created_at ASC`,
    range.from,
    range.to,
    userId,
  );
  if (rows.length === 0) return null;

  const lines = rows
    .map(
      (r) =>
        `@${r.username}  ${r.n}本 / 表示 ${Math.round(r.views).toLocaleString("ja-JP")} / いいね ${Math.round(r.likes).toLocaleString("ja-JP")} / クリック ${Math.round(r.clicks).toLocaleString("ja-JP")}`,
    )
    .join("\n");

  const failed = await ctx.db.all<{ username: string; error: string | null }>(
    `SELECT a.username AS username, q.error AS error
       FROM queue q JOIN accounts a ON a.id=q.account_id
      WHERE a.user_id=? AND q.status='failed' AND q.updated_at>=? AND q.updated_at<?
      ORDER BY q.updated_at ASC LIMIT 10`,
    userId,
    range.from,
    range.to,
  );
  const failures = failed
    .map((f) => `@${f.username}  ${f.error ?? "理由が記録されていません"}`)
    .join("\n");

  return { date: range.label, lines, failures };
}

/**
 * ジョブ本体。`account_id` は持たない（買い手ごとの処理なので）。
 * 時刻の判定は「その買い手の先頭アカウントの timezone」で行う。timezone は
 * アカウント単位でしか持たない決まりのため（SPEC §2.4）。
 */
export async function dailyDigestJob(ctx: JobContext, job: RunningJob): Promise<void> {
  const summary = await runDigest(ctx);
  job.state.sent = summary.sent;
  job.state.skipped = summary.skipped;
}

export async function runDigest(ctx: JobContext): Promise<DigestSummary> {
  // アカウントを1件以上持つ買い手だけが対象。timezone は接続順の先頭のもの
  const users = await ctx.db.all<DigestUser & { timezone: string }>(
    `SELECT u.id AS user_id,
            COALESCE(n.digest_hour, 8) AS digest_hour,
            n.last_digest_date AS last_digest_date,
            n.email_enabled AS email_enabled,
            (SELECT a.timezone FROM accounts a WHERE a.user_id=u.id ORDER BY a.created_at ASC LIMIT 1) AS timezone
       FROM users u
       LEFT JOIN notifications n ON n.user_id=u.id
      WHERE EXISTS (SELECT 1 FROM accounts a2 WHERE a2.user_id=u.id)
      LIMIT 500`,
  );

  let sent = 0;
  let skipped = 0;
  for (const u of users) {
    ctx.budget.timeMs.check();
    if (sent >= MAX_DIGEST_PER_RUN) break;

    const tz = u.timezone ?? ctx.env.DEFAULT_TZ ?? "Asia/Tokyo";
    const { date, hour } = tzDateAndHour(ctx.now, tz);
    if (hour !== u.digest_hour) {
      skipped++;
      continue;
    }
    if (u.last_digest_date === date) {
      skipped++;
      continue;
    }

    // Reserve all DB work before setting the delivery marker. Retry must not skip an unsent user.
    if (ctx.budget.dbQueries.remaining < 4) throw new BudgetExceeded("dbQueries", ctx.budget.dbQueries.used + 4, ctx.budget.dbQueries.limit);
    // 印を先に立てる。メールが失敗しても、その日ぶんを何度も送り直さない
    await ctx.db.run(
      `INSERT INTO notifications (user_id, email_enabled, push_enabled, digest_hour, last_digest_date, updated_at)
         VALUES (?,1,0,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET last_digest_date=excluded.last_digest_date,
           updated_at=excluded.updated_at`,
      u.user_id,
      u.digest_hour,
      date,
      ctx.now.toISOString(),
    );

    const target = await notifyTargetForUser(ctx.db, u.user_id);
    if (!target) {
      skipped++;
      continue; // メール通知がオフ
    }
    const body = await buildBody(ctx, u.user_id, tz);
    if (!body) {
      skipped++;
      continue;
    }
    await sendEmail(ctx.env, target.email, "daily_digest", {
      date: body.date,
      lines: body.lines,
      failures: body.failures,
      appOrigin: ctx.env.APP_ORIGIN,
    });
    sent++;
  }
  return { sent, skipped };
}

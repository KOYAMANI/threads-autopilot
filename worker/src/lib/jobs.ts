/**
 * ジョブ実行の入口（SPEC §8.1 / §8.2）。
 *
 * - `jobs` テーブルがキュー。`scheduled()` が cron に応じて投入し、`runJobs()` が
 *   期限到来分を優先度順に処理する
 * - 1回の `runJobs()` は3つの予算（時間 / 外部fetch / D1クエリ）の範囲で動く。
 *   どれかが尽きたら `BudgetExceeded` を投げ、`state_json` を保存して
 *   `next_run_at=now` の pending に戻す（続きは次の5分）
 * - 同じ `type+account_id` の pending|running は重複投入しない
 * - `running` のまま10分以上経ったジョブは pending に戻す
 * - 失敗は `attempts` を増やし、指数バックオフ（1,2,4,8分）で5回まで。以後 `failed`
 */
import { envInt, type Env } from "../env";
import { budgetFromEnv, createBudget, isBudgetExceeded, type Budget } from "./budget";
import { createDb, type Db } from "./db";
import { markNeedsReauth, isReauthError } from "./accounts";
import { redact } from "./redact";
import { ThreadsApiError } from "./threads-error";
import { HANDLERS } from "../jobs/registry";

/* ── ジョブの種類と優先度（SPEC §8.2） ─────────────── */

export const JOB_TYPES = [
  "publish",
  "full_sync",
  "insights_recent",
  "insights_daily",
  "insights_old",
  "daily_views",
  "followers",
  "demographics",
  "clicks",
  "token_refresh",
  "cleanup",
  "ap_plan",
  "ap_notify",
  "ap_score",
  "daily_digest",
] as const;

export type JobType = (typeof JOB_TYPES)[number];

/** 小さいほど先に走る。publish 系は常に最優先（SPEC §8.2）。 */
export const JOB_PRIORITY: Record<JobType, number> = {
  publish: 1,
  insights_recent: 3,
  // ap_notify は「もう出る」と伝えるものなので、計画より先に届かせる
  ap_notify: 3,
  ap_plan: 4,
  full_sync: 4,
  token_refresh: 4,
  followers: 5,
  daily_views: 5,
  clicks: 6,
  insights_daily: 6,
  insights_old: 8,
  demographics: 8,
  ap_score: 7,
  // 日次ダイジェスト（M7）。急がないので採点のあと
  daily_digest: 8,
  cleanup: 9,
};

/* ── 実行文脈 ──────────────────────────────────────── */

export type JobState = Record<string, unknown>;

export type RunningJob = {
  id: string;
  type: JobType;
  accountId: string | null;
  attempts: number;
  /** ハンドラが直接書き換える。予算切れのときはこの中身がそのまま保存される */
  state: JobState;
};

export type JobContext = {
  env: Env;
  /** 作業用の Db。MAX_DB_QUERIES を消費する */
  db: Db;
  /** ジョブ台帳（jobs テーブル）専用の Db。作業予算とは別枠（下のコメント参照） */
  sys: Db;
  budget: Budget;
  now: Date;
};

export type JobHandler = (ctx: JobContext, job: RunningJob) => Promise<void>;

/**
 * 台帳（jobs テーブル）の読み書きに使う別予算のクエリ数。
 *
 * 作業予算（MAX_DB_QUERIES、既定800）が尽きた**あとに** `state_json` を保存できないと
 * 再開できないので、台帳だけは別の予算で数える。SPEC §2.5 / §8.1 が
 * 「Paid の実測上限は1呼び出し1,000クエリ、既定800は余裕を200残した値」としており、
 * この枠はその200の内側に収まる。
 *
 * 内訳: `runJobs` は1本あたり3クエリ（拾う SELECT・押さえる UPDATE・畳む UPDATE）使うので
 * `MAX_JOBS_PER_RUN` × 3 が下限。残りが `enqueueForCron` の投入（1本あたり
 * 重複確認の SELECT ＋ INSERT の2クエリ）に回る。M6 で毎時の投入が
 * アカウントあたり1本から3本（`insights_recent` / `ap_plan` / `ap_notify`）に増えたので、
 * 150 のままだと `runJobs` のループだけで使い切って cron 全体が落ちていた。
 */
export const JOB_BOOKKEEPING_QUERIES = 190;

function systemDb(env: Env): Db {
  return createDb(
    env.DB,
    createBudget({
      dbQueries: JOB_BOOKKEEPING_QUERIES,
      subrequests: 0,
      timeMs: Number.MAX_SAFE_INTEGER,
    }),
  );
}

/** 本番（`scheduled()` とルート）用。時間予算は実時間で数える。 */
export function createJobContext(env: Env, now = new Date()): JobContext {
  const budget = budgetFromEnv(env);
  return { env, db: createDb(env.DB, budget), sys: systemDb(env), budget, now };
}

/** リクエスト経路（routes/*.ts）から使う。作業用 Db と予算は Hono の文脈のものを流用する。 */
export function jobContextFrom(env: Env, db: Db, budget: Budget, now = new Date()): JobContext {
  return { env, db, sys: systemDb(env), budget, now };
}

/**
 * テスト用。予算と論理時刻を明示して文脈を作る。
 * `now` を進めることで「48h 経過後の取得」などを再現できる（SPEC §14）。
 */
export function makeJobContext(
  env: Env,
  options: {
    now?: Date;
    subrequests?: number;
    dbQueries?: number;
    timeMs?: number;
    clock?: () => number;
  } = {},
): JobContext {
  const budget = createBudget({
    subrequests: options.subrequests ?? envInt(env.MAX_SUBREQUESTS, 300),
    dbQueries: options.dbQueries ?? envInt(env.MAX_DB_QUERIES, 800),
    timeMs: options.timeMs ?? envInt(env.JOB_TIME_BUDGET_MS, 20000),
    ...(options.clock ? { now: options.clock } : {}),
  });
  return {
    env,
    db: createDb(env.DB, budget),
    sys: systemDb(env),
    budget,
    now: options.now ?? new Date(),
  };
}

/* ── 投入 ──────────────────────────────────────────── */

export type EnqueueOptions = {
  accountId?: string | null;
  nextRunAt?: Date;
  priority?: number;
  state?: JobState;
  /** 同種の pending|running があっても投入する（既定 false） */
  force?: boolean;
};

/**
 * ジョブを1件投入する。同じ `type + account_id` の `pending|running` があれば何もしない。
 * @returns 投入したジョブID。重複で見送ったときは null
 */
export async function enqueueJob(
  ctx: JobContext,
  type: JobType,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const accountId = options.accountId ?? null;
  if (!options.force) {
    const dup = await ctx.sys.first<{ id: string }>(
      accountId === null
        ? "SELECT id FROM jobs WHERE type=? AND account_id IS NULL AND status IN ('pending','running') LIMIT 1"
        : "SELECT id FROM jobs WHERE type=? AND account_id=? AND status IN ('pending','running') LIMIT 1",
      ...(accountId === null ? [type] : [type, accountId]),
    );
    if (dup) return null;
  }
  const id = crypto.randomUUID();
  const nowIso = ctx.now.toISOString();
  await ctx.sys.run(
    "INSERT INTO jobs (id, type, account_id, state_json, status, priority, next_run_at, attempts, last_error, created_at, updated_at) VALUES (?,?,?,?, 'pending', ?,?, 0, NULL, ?,?)",
    id,
    type,
    accountId,
    JSON.stringify(options.state ?? {}),
    options.priority ?? JOB_PRIORITY[type] ?? 5,
    (options.nextRunAt ?? ctx.now).toISOString(),
    nowIso,
    nowIso,
  );
  return id;
}

/* ── cron（SPEC §8.2） ─────────────────────────────── */

const CRON_5MIN = "*/5 * * * *";
const CRON_HOURLY = "0 * * * *";
const CRON_DAILY = "0 18 * * *";

/** 週1のジョブを回す曜日（UTC 日曜）。SPEC §8.2 が「週1」としか書いていないので固定する。 */
export const WEEKLY_UTC_DAY = 0;

/**
 * cron に応じてジョブを投入する（SPEC §8.2）。
 * 5分ごとの cron は投入せず `runJobs()` だけを回す。
 */
export async function enqueueForCron(ctx: JobContext, cron: string): Promise<void> {
  try {
    await enqueueForCronInner(ctx, cron);
  } catch (e) {
    // 台帳の予算切れで投入しきれなかっただけ。積めたぶんは `runJobs` に回し、
    // 残りは次の cron が積む（同じ `type+account_id` は重複投入されない）
    if (!isBudgetExceeded(e)) throw e;
  }
}

async function enqueueForCronInner(ctx: JobContext, cron: string): Promise<void> {
  if (cron === CRON_5MIN) {
    // SPEC §8.2 は「runJobs() のみ」だが、publish（§8.3）を動かす入口はここしかない。
    // 出番のあるアカウントにだけ publish を積む。重複投入はしないので、同じアカウントの
    // publish は常に1本（並走してコメントを二重投稿することがない）
    await enqueuePendingPublishes(ctx);
    return;
  }

  const accounts = await ctx.sys.all<{ id: string }>(
    "SELECT id FROM accounts WHERE status='ok' ORDER BY created_at ASC",
  );
  const weekly = ctx.now.getUTCDay() === WEEKLY_UTC_DAY;

  if (cron === CRON_HOURLY) {
    for (const a of accounts) {
      await enqueueJob(ctx, "insights_recent", { accountId: a.id });
      await enqueueJob(ctx, "ap_plan", { accountId: a.id });
      await enqueueJob(ctx, "ap_notify", { accountId: a.id });
    }
    // 日次ダイジェスト（M7）。買い手ごとの `digest_hour` はジョブの中で見るので、
    // 毎時1本だけ積む（アカウント単位ではない）
    await enqueueJob(ctx, "daily_digest");
    return;
  }

  if (cron === CRON_DAILY) {
    for (const a of accounts) {
      await enqueueJob(ctx, "full_sync", { accountId: a.id });
      await enqueueJob(ctx, "insights_daily", { accountId: a.id });
      if (weekly) await enqueueJob(ctx, "insights_old", { accountId: a.id });
      await enqueueJob(ctx, "daily_views", { accountId: a.id });
      await enqueueJob(ctx, "clicks", { accountId: a.id });
      await enqueueJob(ctx, "followers", { accountId: a.id });
      if (weekly) await enqueueJob(ctx, "demographics", { accountId: a.id });
      if (weekly) await enqueueJob(ctx, "token_refresh", { accountId: a.id });
      await enqueueJob(ctx, "ap_score", { accountId: a.id });
    }
    await enqueueJob(ctx, "cleanup");
  }
}

/**
 * 出番のあるキュー（`scheduled` で時刻が来たもの、または途中まで進んだ `publishing`）を
 * 持つアカウントに `publish` を積む（SPEC §8.3）。5分ごとの cron から呼ぶ。
 * 進行中のキューが次のステップを待っている間も、次の5分でここが積み直す。
 */
export async function enqueuePendingPublishes(ctx: JobContext): Promise<void> {
  const nowIso = ctx.now.toISOString();
  const rows = await ctx.sys.all<{ account_id: string }>(
    `SELECT DISTINCT q.account_id AS account_id
       FROM queue q JOIN accounts a ON a.id=q.account_id
      WHERE q.status IN ('scheduled','publishing')
        AND a.status='ok'
        AND q.scheduled_at IS NOT NULL AND q.scheduled_at<=?
        AND (q.next_step_at IS NULL OR q.next_step_at<=?)`,
    nowIso,
    nowIso,
  );
  for (const r of rows) {
    await enqueueJob(ctx, "publish", { accountId: r.account_id });
  }
}

/* ── 実行 ──────────────────────────────────────────── */

type JobRow = {
  id: string;
  type: string;
  account_id: string | null;
  state_json: string;
  status: string;
  priority: number;
  next_run_at: string;
  attempts: number;
};

/** 失敗時の指数バックオフ（分）。SPEC §8.1 */
const BACKOFF_MIN = [1, 2, 4, 8];
export const MAX_JOB_ATTEMPTS = 5;
/** running のまま放置されたジョブを pending に戻すまで（SPEC §8.1） */
export const STALE_RUNNING_MIN = 10;
/**
 * 1回の runJobs で扱うジョブの本数の上限（暴走ガード）。
 * 台帳の予算（`JOB_BOOKKEEPING_QUERIES`）は1本あたり3クエリなので、
 * ここを増やすときは向こうも一緒に上げる。
 */
export const MAX_JOBS_PER_RUN = 40;

export type RunJobsResult = {
  processed: number;
  done: number;
  deferred: number;
  failed: number;
  /** 予算切れで打ち切ったか */
  exhausted: boolean;
};

function parseState(json: string): JobState {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as JobState) : {};
  } catch {
    return {};
  }
}

/**
 * 期限到来のジョブを優先度順に処理する（SPEC §8.1）。
 * `handlers` はテストで差し替えられるようにしてあるが、既定は `jobs/registry.ts`。
 */
export async function runJobs(
  ctx: JobContext,
  handlers: Partial<Record<string, JobHandler>> = HANDLERS,
): Promise<RunJobsResult> {
  const result: RunJobsResult = { processed: 0, done: 0, deferred: 0, failed: 0, exhausted: false };
  const nowIso = ctx.now.toISOString();

  // クラッシュ対策: running のまま10分以上経ったものを戻す
  await ctx.sys.run(
    "UPDATE jobs SET status='pending', updated_at=? WHERE status='running' AND updated_at < ?",
    nowIso,
    new Date(ctx.now.getTime() - STALE_RUNNING_MIN * 60_000).toISOString(),
  );

  for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
    // 予算が尽きていたらここで止める（次の5分で続きから）
    try {
      ctx.budget.timeMs.check();
    } catch {
      result.exhausted = true;
      break;
    }

    // 台帳の読み書き自体が予算切れになることもある（ジョブの本数が多いとき）。
    // その場合も「打ち切って次回」に倒す — ここで throw すると、この呼び出しで
    // すでに終わらせたジョブの結果まで巻き添えで捨てることになる（M6 で実際に踏んだ）
    let row: JobRow | null;
    try {
      row = await ctx.sys.first<JobRow>(
        "SELECT id, type, account_id, state_json, status, priority, next_run_at, attempts FROM jobs WHERE status='pending' AND next_run_at<=? ORDER BY priority ASC, next_run_at ASC LIMIT 1",
        nowIso,
      );
    } catch (e) {
      if (!isBudgetExceeded(e)) throw e;
      result.exhausted = true;
      break;
    }
    if (!row) break;

    // 取り合いを避けるため status='pending' 付きで押さえる
    let claimed = false;
    try {
      const claim = await ctx.sys.run(
        "UPDATE jobs SET status='running', updated_at=? WHERE id=? AND status='pending'",
        nowIso,
        row.id,
      );
      claimed = claim.changes > 0;
    } catch (e) {
      if (!isBudgetExceeded(e)) throw e;
      result.exhausted = true;
      break;
    }
    if (!claimed) continue;

    const job: RunningJob = {
      id: row.id,
      type: row.type as JobType,
      accountId: row.account_id,
      attempts: row.attempts,
      state: parseState(row.state_json),
    };
    result.processed++;

    const handler = handlers[job.type];
    if (!handler) {
      // 未実装のジョブ（ap_* は M6）。落とさず done にして詰まらせない
      await finish(ctx, job, "done", "handler not implemented");
      result.done++;
      continue;
    }

    try {
      await handler(ctx, job);
      await finish(ctx, job, "done", null);
      result.done++;
    } catch (e) {
      if (isBudgetExceeded(e)) {
        // 続きは次回。state_json を保存して pending に戻す（attempts は増やさない）
        await defer(ctx, job);
        result.deferred++;
        result.exhausted = true;
        break;
      }
      if (isReauthError(e) && job.accountId) {
        await markNeedsReauth(ctx.sys, job.accountId, ctx.env);
        await finish(ctx, job, "failed", describeError(e));
        result.failed++;
        continue;
      }
      const attempts = job.attempts + 1;
      if (attempts >= MAX_JOB_ATTEMPTS) {
        await finish(ctx, job, "failed", describeError(e));
        result.failed++;
      } else {
        const delayMin = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)]!;
        await ctx.sys.run(
          "UPDATE jobs SET status='pending', attempts=?, last_error=?, state_json=?, next_run_at=?, updated_at=? WHERE id=?",
          attempts,
          describeError(e),
          JSON.stringify(job.state),
          new Date(ctx.now.getTime() + delayMin * 60_000).toISOString(),
          nowIso,
          job.id,
        );
        result.failed++;
      }
    }
  }

  return result;
}

function describeError(e: unknown): string {
  if (e instanceof ThreadsApiError) {
    return redact(`#${e.code} ${e.message}`).slice(0, 500);
  }
  return redact(String(e instanceof Error ? e.message : e)).slice(0, 500);
}

async function finish(
  ctx: JobContext,
  job: RunningJob,
  status: "done" | "failed",
  error: string | null,
): Promise<void> {
  const nowIso = ctx.now.toISOString();
  await ctx.sys.run(
    "UPDATE jobs SET status=?, state_json=?, last_error=?, updated_at=? WHERE id=?",
    status,
    JSON.stringify(job.state),
    error,
    nowIso,
    job.id,
  );
}

/** 予算切れ。途中経過を保存して次回に回す（SPEC §8.1）。 */
async function defer(ctx: JobContext, job: RunningJob): Promise<void> {
  const nowIso = ctx.now.toISOString();
  await ctx.sys.run(
    "UPDATE jobs SET status='pending', state_json=?, next_run_at=?, updated_at=? WHERE id=?",
    JSON.stringify(job.state),
    nowIso,
    nowIso,
    job.id,
  );
}

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
  "sheets_sync",
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
  sheets_sync: 8,
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

/** Bookkeeping reserves 190 queries alongside the 800-query work budget. Cron pages use batched INSERT SELECT. */
export const JOB_BOOKKEEPING_QUERIES = 190;

function systemDb(env: Env, scheduler = false): Db {
  return createDb(
    env.DB,
    createBudget({
      dbQueries: env.WORKERS_PLAN === "free" ? (scheduler ? 37 : 16) : JOB_BOOKKEEPING_QUERIES,
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

/** Cron only enqueues/dispatches. Its total free DB allowance is 8 work + 37 bookkeeping + 3 cron telemetry = 48. */
export function createSchedulerContext(env: Env, now = new Date()): JobContext {
  if (env.WORKERS_PLAN !== "free") return createJobContext(env, now);
  const budget = createBudget({ dbQueries: 8, subrequests: 20, timeMs: 20000 });
  return { env, db: createDb(env.DB, budget), sys: systemDb(env, true), budget, now };
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
    subrequests: options.subrequests ?? Math.min(envInt(env.MAX_SUBREQUESTS, 300), env.WORKERS_PLAN === "free" ? 20 : 300),
    dbQueries: options.dbQueries ?? Math.min(envInt(env.MAX_DB_QUERIES, 800), env.WORKERS_PLAN === "free" ? 32 : 800),
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
  const id = crypto.randomUUID();
  const nowIso = ctx.now.toISOString();
  const inserted = await ctx.sys.run(
    `INSERT INTO jobs (id,type,account_id,state_json,status,priority,next_run_at,attempts,last_error,created_at,updated_at)
     SELECT ?,?,?,?,'pending',?,?,0,NULL,?,?
     WHERE ?=1 OR NOT EXISTS (SELECT 1 FROM jobs WHERE type=? AND account_id IS ? AND status IN ('pending','running'))`,
    id, type, accountId, JSON.stringify(options.state ?? {}), options.priority ?? JOB_PRIORITY[type] ?? 5,
    (options.nextRunAt ?? ctx.now).toISOString(), nowIso, nowIso, options.force ? 1 : 0, type, accountId,
  );
  if (!inserted.changes) return null;
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

/** Each sweep is durable. A page and its cursor commit together; every minute continues old sweeps. */
async function enqueueForCronInner(ctx: JobContext, cron: string): Promise<void> {
  const period = ctx.now.toISOString();
  if (cron === CRON_HOURLY || cron === CRON_DAILY) {
    const kind = cron === CRON_HOURLY ? "hourly" : "daily";
    const stamp = kind === "hourly" ? period.slice(0, 13) : period.slice(0, 10);
    await ctx.sys.run("INSERT OR IGNORE INTO cron_sweeps(id,kind,period) VALUES (?,?,?)", `${kind}:${stamp}`, kind, period);
  }
  const sweeps = await ctx.sys.all<{id:string;kind:string;period:string;cursor:string}>(
    "SELECT id,kind,period,cursor FROM cron_sweeps WHERE done=0 ORDER BY period,id LIMIT 2",
  );
  for (const sweep of sweeps) {
    const accounts = await ctx.sys.all<{id:string}>("SELECT id FROM accounts WHERE status='ok' AND id>? ORDER BY id LIMIT 200", sweep.cursor);
    const weekly = new Date(sweep.period).getUTCDay() === WEEKLY_UTC_DAY;
    const types: JobType[] = sweep.kind === "hourly" ? ["insights_recent","ap_plan","ap_notify"] :
      ["full_sync","insights_daily","daily_views","clicks","followers","ap_score", ...(weekly ? ["insights_old","demographics","token_refresh"] as JobType[] : [])];
    const end = accounts.at(-1)?.id ?? sweep.cursor;
    const statements: Array<{sql:string;params:unknown[]}> = types.map(type => ({
      sql: `INSERT OR IGNORE INTO jobs(id,type,account_id,state_json,status,priority,next_run_at,attempts,created_at,updated_at)
        SELECT ? || ':' || a.id,?,a.id,'{}','pending',?,?,0,?,? FROM accounts a
        WHERE a.status='ok' AND a.id>? AND a.id<=?
          ${ctx.env.WORKERS_PLAN === "free" && (type === "ap_plan" || type === "ap_notify") ? "AND EXISTS (SELECT 1 FROM autopilot ap WHERE ap.account_id=a.id AND ap.enabled=1)" : ""}
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type=? AND j.account_id=a.id AND j.status IN ('pending','running'))`,
      params: [`${sweep.id}:${type}`, type, JOB_PRIORITY[type], period, period, period, sweep.cursor, end, type],
    }));
    if (accounts.length < 200) {
      const type: JobType = sweep.kind === "hourly" ? "daily_digest" : "cleanup";
      statements.push({sql: `INSERT OR IGNORE INTO jobs(id,type,state_json,status,priority,next_run_at,attempts,created_at,updated_at)
        SELECT ?,?,'{}','pending',?,?,0,?,? WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE type=? AND account_id IS NULL AND status IN ('pending','running'))`,
        params: [`${sweep.id}:${type}`,type,JOB_PRIORITY[type],period,period,period,type]});
    }
    statements.push({sql:"UPDATE cron_sweeps SET cursor=?, done=? WHERE id=? AND cursor=?", params:[end, accounts.length < 200 ? 1 : 0, sweep.id,sweep.cursor]});
    await ctx.sys.batch(statements);
  }
  if (cron === CRON_5MIN || cron === "* * * * *") await enqueuePendingPublishes(ctx);
  await ctx.sys.run("DELETE FROM cron_sweeps WHERE done=1 AND period<?", new Date(ctx.now.getTime()-7*86400_000).toISOString());
}

/** Atomic insertion avoids concurrent cron invocations creating duplicate active publish jobs. */
export async function enqueuePendingPublishes(ctx: JobContext): Promise<void> {
  const now = ctx.now.toISOString();
  await ctx.sys.run(`INSERT INTO jobs(id,type,account_id,state_json,status,priority,next_run_at,attempts,created_at,updated_at)
    SELECT lower(hex(randomblob(16))), 'publish', a.id, '{}','pending',1,?,0,?,? FROM accounts a
    WHERE a.status='ok' AND EXISTS (SELECT 1 FROM queue q WHERE q.account_id=a.id
      AND q.status IN ('scheduled','publishing') AND q.scheduled_at<=? AND (q.next_step_at IS NULL OR q.next_step_at<=?))
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.account_id=a.id AND j.type='publish' AND j.status IN ('pending','running'))
    ORDER BY a.id LIMIT 1000`, now,now,now,now,now);
}

/** DB is the durable outbox. A failed send becomes eligible again after its short dispatch lease. */
export async function dispatchJobs(ctx: JobContext): Promise<void> {
  if (!ctx.env.JOB_QUEUE) return;
  const now = ctx.now.toISOString();
  await ctx.sys.run("UPDATE jobs SET status='pending' WHERE status='running' AND updated_at<?", new Date(ctx.now.getTime()-STALE_RUNNING_MIN*60_000).toISOString());
  // 10 batches of 98: below both D1's 100 bindings and Queues' 100 messages/batch.
  // One small batch per minute would cap throughput below the work created for 1,000 users.
  const batchSize = ctx.env.WORKERS_PLAN === "free" ? 2 : 98;
  for (let page = 0; page < (ctx.env.WORKERS_PLAN === "free" ? 1 : 10); page++) {
    ctx.budget.timeMs.check();
    const ids = await ctx.sys.all<{id:string}>(`SELECT id FROM jobs WHERE status='pending' AND next_run_at<=?
      AND (dispatched_until IS NULL OR dispatched_until<=?) ORDER BY priority,next_run_at LIMIT ${batchSize}`, now, now);
    if (!ids.length) break;
    const lease = new Date(ctx.now.getTime()+5*60_000).toISOString();
    const claims = await ctx.sys.all<{id:string}>(`UPDATE jobs SET dispatched_until=? WHERE id IN (${ids.map(()=>"?").join(",")})
      AND status='pending' AND (dispatched_until IS NULL OR dispatched_until<=?) RETURNING id`, lease,...ids.map(x=>x.id),now);
    if (claims.length) await ctx.env.JOB_QUEUE.sendBatch(claims.map(({id})=>({body:{jobId:id}})));
    if (ids.length < batchSize) break;
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
  onlyJobId?: string,
): Promise<RunJobsResult> {
  const result: RunJobsResult = { processed: 0, done: 0, deferred: 0, failed: 0, exhausted: false };
  const nowIso = ctx.now.toISOString();

  // クラッシュ対策: running のまま10分以上経ったものを戻す
  try { await ctx.sys.run(
    "UPDATE jobs SET status='pending', updated_at=? WHERE status='running' AND updated_at < ?",
    nowIso,
    new Date(ctx.now.getTime() - STALE_RUNNING_MIN * 60_000).toISOString(),
  );

  } catch (e) { if (!isBudgetExceeded(e)) throw e; return { ...result, exhausted: true }; }

  for (let i = 0; i < (onlyJobId || ctx.env.WORKERS_PLAN === "free" ? 1 : MAX_JOBS_PER_RUN); i++) {
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
        `SELECT id, type, account_id, state_json, status, priority, next_run_at, attempts FROM jobs WHERE status='pending' AND next_run_at<=? ${onlyJobId ? "AND id=?" : ""} ORDER BY priority ASC, next_run_at ASC LIMIT 1`,
        nowIso, ...(onlyJobId ? [onlyJobId] : []),
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

/** Wake only this account's ingestion jobs. D1 remains the outbox if Queues is unavailable. */
export const SYNC_JOB_TYPES: JobType[] = ["full_sync", "followers", "daily_views", "insights_recent", "insights_daily", "insights_old", "clicks"];
export async function wakeAccountSync(ctx: JobContext, accountId: string): Promise<void> {
  if (!ctx.env.JOB_QUEUE) return;
  const now = ctx.now.toISOString();
  const lease = new Date(ctx.now.getTime() + 300_000).toISOString();
  const rows = await ctx.sys.all<{id:string}>(`UPDATE jobs SET dispatched_until=?
    WHERE account_id=? AND type IN (${SYNC_JOB_TYPES.map(()=>"?").join(",")})
    AND status='pending' AND next_run_at<=? AND (dispatched_until IS NULL OR dispatched_until<=?) RETURNING id`,
    lease, accountId, ...SYNC_JOB_TYPES, now, now);
  if (!rows.length) return;
  try { await ctx.env.JOB_QUEUE.sendBatch(rows.map(({id})=>({body:{jobId:id}}))); }
  catch { await ctx.sys.run("UPDATE jobs SET dispatched_until=NULL WHERE account_id=? AND dispatched_until=? AND status='pending'", accountId, lease); }
}
export async function enqueueAccountSync(ctx: JobContext, accountId: string): Promise<boolean> {
  let queued = false;
  for (const type of ["full_sync", "followers", "daily_views", "clicks"] as const) {
    if (await enqueueJob(ctx, type, {accountId})) queued = true;
  }
  await wakeAccountSync(ctx, accountId);
  return queued;
}

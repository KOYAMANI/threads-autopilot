/**
 * 1回の呼び出しで使える資源の予算（SPEC §6.1 / §8.1）。三本立て:
 *   subrequests … 外部 fetch 回数（MAX_SUBREQUESTS、既定 300）
 *   dbQueries   … D1 クエリ回数（MAX_DB_QUERIES、既定 800）
 *   timeMs      … 経過時間（JOB_TIME_BUDGET_MS、既定 20,000）
 * どれが尽きても同じ BudgetExceeded を投げる。ジョブは state_json を保存して次回へ持ち越す。
 */
import { envInt, type Env } from "../env";

export type BudgetKind = "subrequests" | "dbQueries" | "timeMs";

export class BudgetExceeded extends Error {
  readonly kind: BudgetKind;
  readonly used: number;
  readonly limit: number;

  constructor(kind: BudgetKind, used: number, limit: number) {
    super(`budget exceeded: ${kind} ${used}/${limit}`);
    this.name = "BudgetExceeded";
    this.kind = kind;
    this.used = used;
    this.limit = limit;
  }
}

export type CountBudget = {
  use(n?: number): void;
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
};

export type TimeBudget = {
  check(): void;
  readonly startedAt: number;
  readonly limit: number;
  readonly elapsed: number;
};

export type Budget = {
  subrequests: CountBudget;
  dbQueries: CountBudget;
  timeMs: TimeBudget;
};

export type BudgetOptions = {
  subrequests?: number;
  dbQueries?: number;
  timeMs?: number;
  /** テストで時刻を進めるための注入点。既定は Date.now */
  now?: () => number;
};

function counter(kind: BudgetKind, limit: number): CountBudget {
  let used = 0;
  return {
    /**
     * n 回使う。使った後に上限を超えていたら投げる。
     * 「上限ちょうど」までは通し、それを超える使用で BudgetExceeded になる。
     */
    use(n = 1) {
      used += n;
      if (used > limit) throw new BudgetExceeded(kind, used, limit);
    },
    get used() {
      return used;
    },
    get limit() {
      return limit;
    },
    get remaining() {
      return Math.max(0, limit - used);
    },
  };
}

export function createBudget(options: BudgetOptions = {}): Budget {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const timeLimit = options.timeMs ?? 20000;
  return {
    subrequests: counter("subrequests", options.subrequests ?? 300),
    dbQueries: counter("dbQueries", options.dbQueries ?? 800),
    timeMs: {
      check() {
        const elapsed = now() - startedAt;
        if (elapsed > timeLimit) throw new BudgetExceeded("timeMs", elapsed, timeLimit);
      },
      get startedAt() {
        return startedAt;
      },
      get limit() {
        return timeLimit;
      },
      get elapsed() {
        return now() - startedAt;
      },
    },
  };
}

/** env の三値から予算を作る（ジョブ・リクエストの入口で1回だけ呼ぶ）。 */
export function budgetFromEnv(env: Env, options: Pick<BudgetOptions, "now"> = {}): Budget {
  return createBudget({
    subrequests: Math.min(envInt(env.MAX_SUBREQUESTS, 300), env.WORKERS_PLAN === "free" ? 20 : 300),
    dbQueries: Math.min(envInt(env.MAX_DB_QUERIES, 800), env.WORKERS_PLAN === "free" ? 32 : 800),
    timeMs: envInt(env.JOB_TIME_BUDGET_MS, 20000),
    now: options.now,
  });
}

export function isBudgetExceeded(e: unknown): e is BudgetExceeded {
  return e instanceof BudgetExceeded;
}

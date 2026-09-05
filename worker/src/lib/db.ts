/**
 * D1 の薄いラッパ（SPEC §2.2 / §8.1）。ORM は使わない。
 * 全クエリで budget.dbQueries.use() を呼び、1呼び出しあたりのクエリ数を数える。
 */
import type { Budget } from "./budget";

export type Db = {
  /** 1行返す（無ければ null）。 */
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>;
  /** 全行返す。 */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  /** INSERT/UPDATE/DELETE。changes と last_row_id を返す。 */
  run(sql: string, ...params: unknown[]): Promise<{ changes: number; lastRowId: number | null }>;
  /** 複数文をまとめて投げる。クエリ数は文の本数ぶん数える。 */
  batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void>;
  /** 使ったクエリ数（デバッグ用）。 */
  readonly queryCount: number;
  readonly raw: D1Database;
};

export function createDb(d1: D1Database, budget: Budget): Db {
  let queryCount = 0;

  const spend = (n = 1) => {
    queryCount += n;
    budget.dbQueries.use(n);
  };

  const bind = (sql: string, params: unknown[]) => {
    const stmt = d1.prepare(sql);
    return params.length ? stmt.bind(...(params as never[])) : stmt;
  };

  return {
    async first<T = Record<string, unknown>>(sql: string, ...params: unknown[]) {
      spend();
      const row = await bind(sql, params).first<T>();
      return (row ?? null) as T | null;
    },

    async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]) {
      spend();
      const res = await bind(sql, params).all<T>();
      return res.results ?? [];
    },

    async run(sql: string, ...params: unknown[]) {
      spend();
      const res = await bind(sql, params).run();
      return {
        changes: res.meta?.changes ?? 0,
        lastRowId: res.meta?.last_row_id ?? null,
      };
    },

    async batch(statements) {
      if (statements.length === 0) return;
      spend(statements.length);
      await d1.batch(statements.map((s) => bind(s.sql, s.params ?? [])));
    },

    get queryCount() {
      return queryCount;
    },

    /**
     * 生の D1Database。**予算を通らない**（budget.dbQueries.use() が呼ばれない）ので、
     * ジョブやルートからは使わない。テストの下準備など、予算の外で叩く用途に限る。
     */
    get raw() {
      return d1;
    },
  };
}

/** D1（SQLite）の1文あたりのバインド変数の上限。超えると `too many SQL variables`。 */
export const D1_MAX_BIND_PARAMS = 100;

/**
 * 1文にまとめられる行数。SPEC §8.1 は「1クエリ50行まで」と書いているが、
 * D1 の実制約はバインド変数100個なので、3列以上では50行に届かない。
 * 列数から実際に通る行数を出す（2列=50行 / 3列=33行 / 5列=20行）。
 */
export function maxRowsPerStatement(columnCount: number, cap = 50): number {
  return Math.max(1, Math.min(cap, Math.floor(D1_MAX_BIND_PARAMS / Math.max(1, columnCount))));
}

/**
 * ON CONFLICT の更新指定。
 * - `"views"` … `views=excluded.views`（既定の書き換え）
 * - `{column:"tags_json", expr:"CASE WHEN posts.tags_json='{}' THEN excluded.tags_json ELSE posts.tags_json END"}`
 *   … 既存値を条件付きで残したいとき（full_sync が採点済みタグを潰さないため。SPEC §8.4 / §9.2）
 */
export type UpsertUpdate = string | { column: string; expr: string };

function updateClause(u: UpsertUpdate): string {
  return typeof u === "string" ? `${u}=excluded.${u}` : `${u.column}=${u.expr}`;
}

/**
 * マルチVALUES の upsert を組み立てる（SPEC §8.1「ループ内で1行ずつ書かない」）。
 * 1文の行数は列数から決める（既定 50 行、ただしバインド上限 100 を超えない）。
 */
export function buildUpsertChunks(
  table: string,
  columns: string[],
  rows: unknown[][],
  conflictColumns: string[],
  updateColumns: UpsertUpdate[],
  chunkSize = maxRowsPerStatement(columns.length),
): Array<{ sql: string; params: unknown[] }> {
  const out: Array<{ sql: string; params: unknown[] }> = [];
  const placeholders = `(${columns.map(() => "?").join(",")})`;
  const size = Math.max(1, Math.min(chunkSize, maxRowsPerStatement(columns.length)));
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const sql =
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ` +
      chunk.map(() => placeholders).join(",") +
      ` ON CONFLICT(${conflictColumns.join(",")}) DO ` +
      (updateColumns.length
        ? `UPDATE SET ${updateColumns.map(updateClause).join(",")}`
        : "NOTHING");
    out.push({ sql, params: chunk.flat() });
  }
  return out;
}

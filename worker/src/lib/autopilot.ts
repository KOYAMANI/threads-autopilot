import { hasAiDataConsent } from "@tap/shared";
/**
 * オートパイロットの共通処理（SPEC §7.7 / §9）。
 * ルート（`routes/autopilot.ts`）とジョブ（`jobs/plan.ts` / `notify.ts` / `score.ts`）で共用する。
 *
 * ここに AI は出てこない。生成だけが `lib/ai.ts` の仕事（SPEC §10 冒頭）。
 */
import type { AutopilotBlocker, AutopilotSettings } from "@tap/shared";
import type { Db } from "./db";

export type AutopilotRow = {
  account_id: string;
  enabled: number;
  per_week: number;
  slot_mode: string;
  fixed_hour: number | null;
  approval_mode: string;
  approval_window_h: number;
  daily_limit: number;
  quiet_hours: number;
  ng_words: string;
  link_placement: string;
  hook_mode: string;
  fixed_hook: string | null;
  score_weights: string;
  consecutive_failures: number;
  updated_at: string;
};

export const AUTOPILOT_SELECT =
  "account_id, enabled, per_week, slot_mode, fixed_hour, approval_mode, approval_window_h, " +
  "daily_limit, quiet_hours, ng_words, link_placement, hook_mode, fixed_hook, score_weights, " +
  "consecutive_failures, updated_at";

/** 行が無いアカウントの既定値（SPEC §4 の DEFAULT と揃える）。 */
export function defaultAutopilot(accountId: string): AutopilotRow {
  return {
    account_id: accountId,
    enabled: 0,
    per_week: 21,
    slot_mode: "auto",
    fixed_hour: null,
    approval_mode: "cancel",
    approval_window_h: 4,
    daily_limit: 3,
    quiet_hours: 1,
    ng_words: "",
    link_placement: "comment",
    hook_mode: "auto",
    fixed_hook: null,
    score_weights: "balanced",
    consecutive_failures: 0,
    updated_at: "",
  };
}

/** 設定を読む。行が無ければ既定値（作りはしない）。 */
export async function loadAutopilot(db: Db, accountId: string): Promise<AutopilotRow> {
  const row = await db.first<AutopilotRow>(
    `SELECT ${AUTOPILOT_SELECT} FROM autopilot WHERE account_id=?`,
    accountId,
  );
  return row ?? defaultAutopilot(accountId);
}

export function toAutopilotSettings(row: AutopilotRow): AutopilotSettings {
  return {
    accountId: row.account_id,
    enabled: Boolean(row.enabled),
    perWeek: row.per_week,
    slotMode: (row.slot_mode as "auto" | "fixed") ?? "auto",
    fixedHour: row.fixed_hour,
    approvalMode: (row.approval_mode as AutopilotSettings["approvalMode"]) ?? "cancel",
    approvalWindowH: row.approval_window_h,
    dailyLimit: row.daily_limit,
    quietHours: Boolean(row.quiet_hours),
    ngWords: row.ng_words,
    linkPlacement: (row.link_placement as AutopilotSettings["linkPlacement"]) ?? "comment",
    hookMode: (row.hook_mode as "auto" | "fixed") ?? "auto",
    fixedHook: row.fixed_hook,
    scoreWeights: (row.score_weights as AutopilotSettings["scoreWeights"]) ?? "balanced",
    consecutiveFailures: row.consecutive_failures,
    updatedAt: row.updated_at === "" ? null : row.updated_at,
  };
}

/* ── ON にできる条件（SPEC §7.7） ────────────────────── */

/** 画面のトーストに出す日本語（SPEC §12.3 Autopilot）。 */
export const BLOCKER_MESSAGE: Record<AutopilotBlocker, string> = {
  no_key:
    "設定でAIキーと送信先・利用条件を確認して保存してください",
  no_source: "参考情報が1件もありません。「作る」から参考情報を追加してください",
  needs_reauth: "このアカウントは再接続が必要です。設定からつなぎ直してください",
  license: "ライセンスが無効になっています",
};

/**
 * `enabled=true` にできるかを見る（SPEC §7.7 の4条件）。
 * AIキーがサーバー保存・参考情報1件以上・`accounts.status='ok'`・ライセンスが `active`。
 */
export async function autopilotBlockers(
  db: Db,
  options: { accountId: string; userId: string; accountStatus: string },
): Promise<AutopilotBlocker[]> {
  const out: AutopilotBlocker[] = [];

  const ai = await db.first<{ key_enc: string | null; store_on_server: number; provider: string; model: string | null; data_policy_version: string | null }>(
    "SELECT key_enc, store_on_server, provider, model, data_policy_version FROM ai_settings WHERE user_id=?",
    options.userId,
  );
  if (!ai || !ai.store_on_server || !ai.key_enc || !hasAiDataConsent(ai)) out.push("no_key");

  const src = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sources WHERE user_id=? AND enabled_for_ap=1",
    options.userId,
  );
  if ((src?.n ?? 0) < 1) out.push("no_source");

  if (options.accountStatus !== "ok") out.push("needs_reauth");

  const lic = await db.first<{ status: string }>(
    "SELECT l.status AS status FROM users u JOIN licenses l ON l.id=u.license_id WHERE u.id=?",
    options.userId,
  );
  if ((lic?.status ?? "revoked") !== "active") out.push("license");

  return out;
}

/* ── ap_log（SPEC §9.4-6） ───────────────────────────── */

export type ApLogKind =
  | "plan"
  | "cancel"
  | "approve"
  | "skip"
  | "error"
  | "stopped"
  | "notify"
  | "score";

/** 1行足す。ここは記録なので、失敗しても呼び出し側の処理は止めない。 */
export async function apLog(
  db: Db,
  accountId: string,
  kind: ApLogKind,
  message: string,
  refId: string | null = null,
  now: Date = new Date(),
): Promise<void> {
  await db.run(
    "INSERT INTO ap_log (id, account_id, at, kind, message, ref_id) VALUES (?,?,?,?,?,?)",
    crypto.randomUUID(),
    accountId,
    now.toISOString(),
    kind,
    message.slice(0, 500),
    refId,
  );
}

/* ── ライセンス（SPEC §5.4） ─────────────────────────── */

/**
 * アカウントの持ち主のライセンスが `active` か。`revoked` のときは
 * `autopilot.enabled=0` にして `ap_log` に残す（SPEC §5.4「セッションが生きているうちに
 * 自動投稿が続くのを防ぐ」）。
 */
export async function licenseActiveOrStop(
  db: Db,
  accountId: string,
  now: Date,
): Promise<boolean> {
  const row = await db.first<{ status: string }>(
    `SELECT l.status AS status
       FROM accounts a JOIN users u ON u.id=a.user_id JOIN licenses l ON l.id=u.license_id
      WHERE a.id=?`,
    accountId,
  );
  if ((row?.status ?? "revoked") === "active") return true;
  const res = await db.run(
    "UPDATE autopilot SET enabled=0, updated_at=? WHERE account_id=? AND enabled=1",
    now.toISOString(),
    accountId,
  );
  if (res.changes > 0) {
    await apLog(
      db,
      accountId,
      "stopped",
      "ライセンスが無効になったため、オートパイロットを止めました",
      null,
      now,
    );
  }
  return false;
}

/* ── 直近の自動投稿（ローテーション用。SPEC §9.3 / §9.4） ── */

export type RecentAuto = { hook: string | null; slot: string | null };

/**
 * 直近の自動投稿が使った型と枠を新しい順に返す（`tags_json` から読む）。
 * 予約済み・投稿済みの両方を見る（作ったばかりの下書きも「直近3本」に数える）。
 */
export async function recentAutoTags(
  db: Db,
  accountId: string,
  limit = 3,
): Promise<RecentAuto[]> {
  const rows = await db.all<{ tags_json: string }>(
    `SELECT tags_json FROM queue
       WHERE account_id=? AND source='autopilot' AND status<>'cancelled'
       ORDER BY created_at DESC LIMIT ?`,
    accountId,
    limit,
  );
  return rows.map((r) => {
    try {
      const t = JSON.parse(r.tags_json) as { hook?: unknown; slot?: unknown; daytype?: unknown };
      const hook = typeof t.hook === "string" ? t.hook : null;
      const slot =
        typeof t.daytype === "string" && (typeof t.slot === "string" || typeof t.slot === "number")
          ? `${t.daytype}-${t.slot}`
          : null;
      return { hook, slot };
    } catch {
      return { hook: null, slot: null };
    }
  });
}

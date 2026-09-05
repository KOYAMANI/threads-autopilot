/**
 * API のリクエスト / レスポンス型（SPEC §2.4 / §7）。web と worker で共有する。
 * M1 の範囲（auth / admin / health）は確定。それ以外は後続マイルストーンで埋める。
 */

/* ── 応答の包み（SPEC §2.4） ─────────────────────────── */

export type ApiOk<T> = { ok: true; data: T };
export type ApiErrorBody = { code: string; message: string; detail?: unknown };
export type ApiErr = { ok: false; error: ApiErrorBody };
export type ApiResponse<T> = ApiOk<T> | ApiErr;

/** M1 で使うエラーコード。ユーザーに見せる文言は message 側（日本語）。 */
export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CSRF"
  | "RATE_LIMITED"
  | "EMAIL_TAKEN"
  | "LICENSE_INVALID"
  | "LICENSE_REVOKED"
  | "LOGIN_FAILED"
  | "RESET_INVALID"
  | "WEAK_PASSWORD"
  | "VALIDATION"
  | "BUDGET_EXCEEDED"
  | "THREADS_ERROR"
  | "INTERNAL";

/* ── 認証（SPEC §5.1 / §7） ──────────────────────────── */

export type RegisterRequest = { email: string; password: string; license_key: string };
export type LoginRequest = { email: string; password: string };
export type ForgotRequest = { email: string };
export type ResetRequest = { token: string; password: string };

export type UserSummary = {
  id: string;
  email: string;
  createdAt: string;
  lastLoginAt: string | null;
};

export type AccountStatus = "ok" | "needs_reauth" | "disabled";

export type AccountSummary = {
  id: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  color: string;
  status: AccountStatus;
  timezone: string;
  tokenExpiresInDays: number | null;
  longLived: boolean;
  lastFullSyncAt: string | null;
  autopilotEnabled: boolean;
};

export type AiSettingsSummary = {
  provider: "gemini" | "openrouter" | null;
  model: string | null;
  hasKey: boolean;
  storeOnServer: boolean;
};

export type NotificationSettings = {
  emailEnabled: boolean;
  pushEnabled: boolean;
  digestHour: number;
};

/** GET /api/auth/me */
export type MeResponse = {
  user: UserSummary;
  accounts: AccountSummary[];
  ai: AiSettingsSummary;
  notifications: NotificationSettings;
};

export type RegisterResponse = { user: UserSummary };
export type LoginResponse = { user: UserSummary };

/* ── 管理API（SPEC §5.4） ────────────────────────────── */

export type IssueLicensesRequest = { count: number; note?: string };
export type IssueLicensesResponse = { keys: Array<{ id: string; key: string }> };
export type RevokeLicenseResponse = { id: string; status: "revoked"; revokedAt: string };

/* ── その他（SPEC §7.8） ─────────────────────────────── */

export type HealthResponse = { ok: true; version: string; mock: boolean };

/* ── 型ヘルパ ───────────────────────────────────────── */

export function ok<T>(data: T): ApiOk<T> {
  return { ok: true, data };
}

export function err(code: ErrorCode | string, message: string, detail?: unknown): ApiErr {
  return { ok: false, error: detail === undefined ? { code, message } : { code, message, detail } };
}

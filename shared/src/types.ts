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

/* ── アカウント（SPEC §7.1） ─────────────────────────── */

export type ConnectAccountRequest = { token: string; app_secret?: string };
export type ConnectAccountResponse = {
  account: AccountSummary;
  longLived: boolean;
  /** app_secret を受け取ったが使わなかったとき true（長期化に失敗した等） */
  secretIgnored: boolean;
};

export type PatchAccountRequest = {
  color?: string;
  timezone?: string;
  settings?: Record<string, unknown>;
};

export type DiagnoseStep = { name: string; ok: boolean; detail: string };
export type DiagnoseResponse = { steps: DiagnoseStep[] };

/** `GET /accounts/:id/sync`。progress / total はページ数（SPEC §7.1） */
export type SyncStatus = { running: boolean; progress: number; total: number };

export type RefreshTokenResponse = {
  refreshed: boolean;
  longLived: boolean;
  tokenExpiresInDays: number | null;
  message: string;
};

/* ── ダッシュボード（SPEC §7.2） ─────────────────────── */

export type DashboardPeriod = 7 | 14 | 21 | 30 | 90 | "all";

export type PostLink = { url: string; label: string; kind: string };

export type PostChild = { id: string; text: string; views: number };

export type PostSummary = {
  id: string;
  text: string;
  permalink: string | null;
  postedAt: string;
  mediaType: string;
  hasImage: boolean;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  shares: number;
  clicks: number;
  link: PostLink | null;
  hook: string;
  children: PostChild[];
};

export type DashboardResponse = {
  period: DashboardPeriod;
  from: string;
  to: string;
  followers: { current: number; delta: number; series: Array<{ date: string; n: number }> };
  views: { total: number; series: Array<{ date: string; v: number }> };
  likes: number;
  clicks: number;
  posts: PostSummary[];
  links: Array<{ url: string; label: string; kind: string; clicks: number; posts: number }>;
  unassignedClicks: number;
};

/* ── 投稿（SPEC §7.3） ───────────────────────────────── */

export type PostListResponse = { posts: PostSummary[]; cursor: string | null };

export type PostHistoryPoint = {
  checkpoint: "48h" | "7d" | "30d";
  at: string;
  views: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
};

export type PostDetailResponse = { post: PostSummary; history: PostHistoryPoint[] };

/* ── リンク（SPEC §7.5） ─────────────────────────────── */

export type LinkKind = "line" | "affiliate" | "other";

export type LinkSummary = {
  id: string;
  url: string;
  label: string;
  kind: LinkKind;
  enabledForAp: boolean;
  lastUsedAt: string | null;
  createdAt: string;
};

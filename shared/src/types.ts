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
  | "AI_KEY_REQUIRED"
  | "AI_BAD_OUTPUT"
  | "AI_FAILED"
  | "EXTRACT_FAILED"
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

/* ── キュー（SPEC §7.4 / §12.3） ─────────────────────── */

export type QueueStatus =
  | "draft"
  | "pending_approval"
  | "scheduled"
  | "publishing"
  | "done"
  | "failed"
  | "cancelled";

export type QueueSource = "manual" | "autopilot" | "recycle";
export type ReplyControl = "everyone" | "accounts_you_follow" | "mentioned_only";

/** `done` のときだけ付く、実際に出た投稿の数字（SPEC §7.4「`done` は `posts` の数字を結合」）。 */
export type QueueMetrics = {
  postId: string;
  permalink: string | null;
  postedAt: string;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  shares: number;
  clicks: number;
};

export type QueueItem = {
  id: string;
  accountId: string;
  status: QueueStatus;
  scheduledAt: string | null;
  body: string;
  comments: string[];
  imageUrl: string | null;
  replyControl: ReplyControl;
  source: QueueSource;
  approvalMode: "manual" | "cancel" | "auto" | null;
  /** 取消可モードの締切。残り時間の計算は client 側（SPEC §12.3） */
  approveDeadline: string | null;
  step: number;
  containerPolls: number;
  /** 公開済みの投稿ID。二重投稿防止のため、成功したぶんは必ず保存される（SPEC §8.3） */
  resultIds: string[];
  /** ユーザー向けの日本語 */
  error: string | null;
  /** Threads からの返答そのまま */
  errorRaw: string | null;
  attempts: number;
  originPostId: string | null;
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
  metrics: QueueMetrics | null;
};

export type QueueListResponse = { items: QueueItem[] };

export type CreateQueueRequest = {
  /** `now` は「今すぐ投稿」（`scheduledAt = now` にして予約する） */
  status: "draft" | "scheduled" | "now";
  scheduledAt?: string;
  body: string;
  comments?: string[];
  imageUrl?: string | null;
  replyControl?: ReplyControl;
  originPostId?: string | null;
  sourceIds?: string[];
};

export type PatchQueueRequest = {
  body?: string;
  comments?: string[];
  scheduledAt?: string | null;
  imageUrl?: string | null;
  replyControl?: ReplyControl;
  status?: "draft" | "scheduled";
};

export type QueueItemResponse = { item: QueueItem };

/** `GET /accounts/:id/queue/suggest-slot`（SPEC §7.4 / §9.3）。 */
export type SuggestSlotResponse = { at: string; reason: string; n: number };

/* ── 参考情報（SPEC §7.5 / §10.4） ───────────────────── */

export type SourceType = "text" | "youtube" | "file" | "url";

/** `sources` 1件。`content` は一覧では先頭だけ返す（`contentPreview`）。 */
export type SourceSummary = {
  id: string;
  type: SourceType;
  title: string;
  url: string | null;
  charCount: number;
  contentPreview: string;
  enabledForAp: boolean;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
};

export type SourceListResponse = { sources: SourceSummary[] };
export type SourceItemResponse = { source: SourceSummary };

export type CreateSourceRequest = {
  type: SourceType;
  title?: string;
  url?: string;
  /** `text` / `file` は必須。`url` はサーバーで抽出、`youtube` は空でよい */
  content?: string;
};

export type PatchSourceRequest = {
  title?: string;
  content?: string;
  enabledForAp?: boolean;
};

/* ── AI（SPEC §7.6 / §10） ──────────────────────────── */

export type AiProvider = "gemini" | "openrouter";

export const AI_DEFAULT_MODEL: Record<AiProvider, string> = {
  gemini: "gemini-2.5-flash",
  openrouter: "anthropic/claude-sonnet-4.6",
};

/** `GET /ai/settings` / `PUT /ai/settings` の応答（SPEC §7.6）。 */
export type AiSettingsResponse = {
  provider: AiProvider | null;
  model: string | null;
  hasKey: boolean;
  storeOnServer: boolean;
  /** `storeOnServer=false` なら false。サーバーが自動生成のときにキーを読めないため */
  autopilotAvailable: boolean;
};

export type PutAiSettingsRequest = {
  provider: AiProvider;
  key?: string;
  model?: string;
  storeOnServer: boolean;
};

export type AiTestRequest = { clientKey?: string };
export type AiTestResponse = { ok: true; model: string; latencyMs: number };

/** 1案（SPEC §7.6 / §10.3）。`key` は案A / 案B / 案C の識別子。 */
export type AiCandidate = {
  key: string;
  hook: string;
  body: string;
  comments: string[];
  basis: string;
};

export type AiPickMode = "template" | "rewrite";

export type AiGenerateRequest = {
  accountId: string;
  picks?: string[];
  pickMode?: AiPickMode;
  sourceIds?: string[];
  instruction?: string;
  n?: number;
  /** ブラウザ保存モードのときだけ付く。サーバーに保存しない */
  clientKey?: string;
};

export type AiGenerateResponse = {
  candidates: AiCandidate[];
  /** OpenRouter に YouTube を渡せないときなど、画面に出す案内 */
  notes: string[];
};

/** 会話履歴（SPEC §7.6 の `history`）。 */
export type AiHistoryTurn = { role: "user" | "assistant"; text: string };

export type AiReviseRequest = {
  accountId: string;
  candidate: AiCandidate;
  instruction: string;
  history?: AiHistoryTurn[];
  clientKey?: string;
};

export type AiReviseResponse = { candidate: AiCandidate };

/* ── オートパイロット（SPEC §7.7 / §9） ─────────────── */

export type ApprovalMode = "manual" | "cancel" | "auto";
export type LinkPlacementSetting = "comment" | "body" | "none";
export type ScoreWeightsSetting = "balanced" | "followers" | "clicks";

/** `autopilot` の1行（SPEC §4）。画面はこの形で読み書きする。 */
export type AutopilotSettings = {
  accountId: string;
  enabled: boolean;
  /** 週あたり本数（1日1本=7, 1日2本=14, 週3本=3, 週5本=5） */
  perWeek: number;
  slotMode: "auto" | "fixed";
  fixedHour: number | null;
  approvalMode: ApprovalMode;
  /** 取消可モードで、投稿の何時間前に通知するか */
  approvalWindowH: number;
  dailyLimit: number;
  /** 0〜6時は出さない */
  quietHours: boolean;
  ngWords: string;
  linkPlacement: LinkPlacementSetting;
  hookMode: "auto" | "fixed";
  fixedHook: string | null;
  scoreWeights: ScoreWeightsSetting;
  consecutiveFailures: number;
  updatedAt: string | null;
};

/** ON にできない理由（SPEC §7.7 の4条件 / §12.3 のトースト）。 */
export type AutopilotBlocker = "no_key" | "no_source" | "needs_reauth" | "license";

export type AutopilotResponse = {
  settings: AutopilotSettings;
  /** ON にできるか。できないときは `blockers` に理由が並ぶ */
  canEnable: boolean;
  blockers: AutopilotBlocker[];
  /** 画面のトーストに出す日本語（`blockers` と同じ並び） */
  blockerMessages: string[];
};

export type PutAutopilotRequest = Partial<
  Omit<AutopilotSettings, "accountId" | "consecutiveFailures" | "updatedAt">
>;

/** `GET /accounts/:id/autopilot/learning`（SPEC §7.7）。`n < 10` の行は数値が null。 */
export type LearningRow = {
  dim: "hook" | "slot" | "length" | "source";
  value: string;
  n: number;
  avgScore: number | null;
  avgViews: number | null;
  likeRate: number | null;
  /** `dim='source'` のときの参考情報のタイトル（消えていたら null） */
  label: string | null;
};

export type LearningResponse = { rows: LearningRow[] };

export type ApLogEntry = {
  id: string;
  at: string;
  kind: string;
  message: string;
  refId: string | null;
};

export type ApLogResponse = { entries: ApLogEntry[] };

/** `GET /accounts/:id/autopilot/next`（SPEC §7.7）。ApBar が読む。 */
export type ApNextResponse = {
  enabled: boolean;
  item: QueueItem | null;
  /** ApBar に出す1行（「次は 9/7 21:00。取消は 17:00 まで」など） */
  summary: string;
};

/* ── 通知・Push（SPEC §7.8 / §12.4） ─────────────────── */

export type PutNotificationsRequest = Partial<NotificationSettings>;

export type NotificationsResponse = {
  notifications: NotificationSettings;
  /** Web Push の公開鍵（未設定なら null。画面は購読ボタンを出さない） */
  vapidPublicKey: string | null;
};

export type PushSubscribeRequest = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type PushSubscribeResponse = { id: string };

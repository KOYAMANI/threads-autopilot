/**
 * Threads API 呼び出し（SPEC §6）。
 * call() の骨格・threadsReason()・モック分岐と、§6.3 の各エンドポイントのラッパ。
 * 投稿系（`POST /me/threads` / コンテナ / `threads_publish`）はファイル末尾。
 * ステップの組み立ては `jobs/publish.ts`（SPEC §8.3）。
 */
import { DEV, type Env } from "../env";
import type { Budget } from "./budget";
import { redact } from "./redact";
import {
  isRateLimit,
  parseThreadsError,
  ThreadsApiError,
  type ThreadsError,
} from "./threads-error";

export const BASE = "https://graph.threads.net/v1.0";

// エラーまわりは lib/threads-error.ts に置いてある（mock からも使うため）。
// 呼び出し側は従来どおり lib/threads.ts から import できる。
export {
  isRateLimit,
  isTokenInvalid,
  parseThreadsError,
  RATE_LIMIT_CODES,
  ThreadsApiError,
  threadsReason,
  type ThreadsError,
} from "./threads-error";

const RETRY_DELAYS_MS = [1500, 3000, 6000];

export type ThreadsParams = Record<string, string | number | boolean | undefined | null>;

export type CallOptions = {
  budget: Budget;
  env: Env;
  /** テストで時刻・待機を差し替えるための注入点 */
  now?: number;
  sleep?: (ms: number) => Promise<void>;
};

function toQuery(params: ThreadsParams): URLSearchParams {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    q.set(k, String(v));
  }
  return q;
}

/**
 * THREADS_MOCK=1 かつ DEV ビルドかつ `THAAdemo` トークンならモックに入る（SPEC §11）。
 * **表示・診断用**。`call()` の分岐にこの関数を使ってはいけない。関数を挟むと
 * esbuild のデッドコード除去が効かず、mock/ が本番バンドルに残る。
 */
export function shouldUseMock(env: Env, token: string): boolean {
  return DEV && env.THREADS_MOCK === "1" && token.startsWith("THAAdemo");
}

/** /api/health の `mock` フラグ。本番ビルドでは常に false になる。 */
export function mockAvailable(env: Env): boolean {
  return DEV && env.THREADS_MOCK === "1";
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Threads API を1回呼ぶ。
 * - 通常のAPIはBearerヘッダ。トークン交換・延長だけMeta所定のクエリ方式。
 * - 失敗は ThreadsApiError を throw
 * - レート制限（4/17/32/613）だけ 1.5s→3s→6s で最大3回リトライ
 * - budget.subrequests.use() で外部 fetch 回数を数える（尽きたら BudgetExceeded）
 */
export async function call(
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: ThreadsParams,
  options: CallOptions,
): Promise<unknown> {
  const { budget, env } = options;
  // Staging cannot publish, repost, or delete even if a real token is accidentally configured.
  if (env.APP_ENV === "staging" && method !== "GET") {
    throw new ThreadsApiError({code:403, message:"ステージングではThreadsへの投稿操作を停止しています", raw:""});
  }
  const p = path.startsWith("/") ? path : `/${path}`;

  // `__DEV__` は esbuild の define で置き換わるビルド時定数（worker/src/globals.d.ts）。
  // ここは **識別子を直接** 書く。別モジュールの定数（env.ts の DEV）や shouldUseMock()
  // を挟むとデッドコード除去が効かない。枝の中でもモック側の名前を使わない
  // （default エクスポート経由。エラー整形もモック側で済ませる）。名前で呼ぶと
  // `__DEV__=false` のビルドで、消えた枝の中にその名前だけが文字列として残る。
  // 回帰確認は scripts/check-bundle.sh。
  if (__DEV__ && env.THREADS_MOCK === "1" && token.startsWith("THAAdemo")) {
    budget.subrequests.use();
    const mod = await import("../mock/threads");
    return mod.default({ token, method, path: p, params, now: options.now });
  }

  const sleep = options.sleep ?? defaultSleep;
  let lastError: ThreadsError | null = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    budget.subrequests.use();
    // OAuth exchange/refresh explicitly require access_token as a parameter.
    // Keep normal profile, insight and publishing requests free of URL credentials.
    const tokenEndpoint = p === "/access_token" || p === "/refresh_access_token";
    const cleanParams = { ...params };
    delete cleanParams.access_token;
    const query = toQuery(tokenEndpoint ? { ...cleanParams, access_token: token } : cleanParams);
    const url = `${BASE}${p}?${query.toString()}`;
    const headers: HeadersInit = tokenEndpoint ? {} : { Authorization: `Bearer ${token}` };
    const remainingMs = Math.max(1, Math.min(15000, budget.timeMs.limit - budget.timeMs.elapsed));
    budget.timeMs.check();
    const res = await fetch(url, { method, headers, redirect: "error", signal: AbortSignal.timeout(remainingMs) });
    const bodyText = await res.text();

    if (res.ok) {
      try {
        return JSON.parse(bodyText) as unknown;
      } catch {
        throw new ThreadsApiError({
          code: res.status,
          message: "応答をJSONとして読めませんでした",
          raw: redact(bodyText.slice(0, 1000)),
        });
      }
    }

    lastError = parseThreadsError(res.status, bodyText);
    if (!isRateLimit(lastError) || attempt === RETRY_DELAYS_MS.length) break;
    await sleep(RETRY_DELAYS_MS[attempt]!);
  }

  throw new ThreadsApiError(lastError ?? { code: 0, message: "unknown", raw: "" });
}

/* ── §6.3 の各呼び出しのラッパ ───────────────────────
 * どれも call() を通すので、モック分岐・リトライ・予算はここでは書かない。
 * 応答の形は docs/threads-api.md §3〜§6 に合わせる。
 */

/** 投稿一覧・返信一覧で取るフィールド（SPEC §6.3）。 */
export const POST_FIELDS =
  "id,text,permalink,timestamp,is_reply,replied_to,root_post,has_replies,media_type,media_url,link_attachment_url,is_quote_post";

/** 投稿ごとのインサイトのメトリクス（SPEC §6.3）。 */
export const POST_METRICS = "views,likes,replies,reposts,quotes,shares";

export type ThreadsProfile = {
  id: string;
  username: string;
  name?: string | null;
  threads_profile_picture_url?: string | null;
};

export type ThreadsMedia = {
  id: string;
  text?: string;
  permalink?: string;
  timestamp?: string;
  is_reply?: boolean;
  replied_to?: { id?: string } | null;
  root_post?: { id?: string } | null;
  has_replies?: boolean;
  media_type?: string;
  media_url?: string | null;
  link_attachment_url?: string | null;
  is_quote_post?: boolean;
};

export type ThreadsPage = {
  data: ThreadsMedia[];
  paging?: { cursors?: { after?: string; before?: string }; next?: string };
};

/** 接続確認（SPEC §6.3）。 */
export async function getProfile(token: string, options: CallOptions): Promise<ThreadsProfile> {
  return (await call(
    token,
    "GET",
    "/me",
    { fields: "id,username,name,threads_profile_picture_url" },
    options,
  )) as ThreadsProfile;
}

/** 短期 → 長期トークン（60日）。App Secret は保存しない（SPEC §6.3）。 */
export async function exchangeToken(
  token: string,
  appSecret: string,
  options: CallOptions,
): Promise<{ access_token: string; expires_in?: number }> {
  return (await call(
    token,
    "GET",
    "/access_token",
    { grant_type: "th_exchange_token", client_secret: appSecret },
    options,
  )) as { access_token: string; expires_in?: number };
}

/** 長期トークンの延長（発行24h後から。SPEC §6.3 / §8.6）。 */
export async function refreshLongLivedToken(
  token: string,
  options: CallOptions,
): Promise<{ access_token: string; expires_in?: number }> {
  return (await call(
    token,
    "GET",
    "/refresh_access_token",
    { grant_type: "th_refresh_token" },
    options,
  )) as { access_token: string; expires_in?: number };
}

/** 自分の投稿一覧（root）。1ページ最大100件。 */
export async function listThreads(
  token: string,
  params: { limit?: number; after?: string },
  options: CallOptions,
): Promise<ThreadsPage> {
  return (await call(
    token,
    "GET",
    "/me/threads",
    { fields: POST_FIELDS, limit: params.limit ?? 100, after: params.after },
    options,
  )) as ThreadsPage;
}

/** 自分が書いた返信（ツリーの2投稿目以降）。 */
export async function listReplies(
  token: string,
  params: { limit?: number; after?: string },
  options: CallOptions,
): Promise<ThreadsPage> {
  return (await call(
    token,
    "GET",
    "/me/replies",
    { fields: POST_FIELDS, limit: params.limit ?? 100, after: params.after },
    options,
  )) as ThreadsPage;
}

export type PostMetrics = {
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  shares: number;
};

type InsightEntry = {
  name?: string;
  values?: Array<{ value?: number; end_time?: string }>;
  total_value?: { value?: number; breakdowns?: unknown };
  link_total_values?: Array<{ value?: number; link_url?: string }>;
};

/** `data[].values[0].value ?? total_value.value`（SPEC §6.3）。 */
function insightValue(entry: InsightEntry): number {
  const v = entry.values?.[0]?.value;
  if (typeof v === "number") return v;
  const t = entry.total_value?.value;
  return typeof t === "number" ? t : 0;
}

/** 投稿1件の数字。取れなかったメトリクスは null にして、呼び出し側が前回値を残せるようにする。 */
export async function getPostInsights(
  token: string,
  mediaId: string,
  options: CallOptions,
): Promise<Partial<PostMetrics>> {
  const res = (await call(
    token,
    "GET",
    `/${mediaId}/insights`,
    { metric: POST_METRICS },
    options,
  )) as { data?: InsightEntry[] };
  const out: Partial<PostMetrics> = {};
  for (const entry of res.data ?? []) {
    const name = entry.name;
    if (!name) continue;
    if (
      name === "views" ||
      name === "likes" ||
      name === "replies" ||
      name === "reposts" ||
      name === "quotes" ||
      name === "shares"
    ) {
      out[name] = insightValue(entry);
    }
  }
  return out;
}

/** 日別の表示回数（`/me/threads_insights?metric=views`）。7日ずつ区切って呼ぶ（SPEC §8.4）。 */
export async function getDailyViews(
  token: string,
  params: { sinceSec: number; untilSec: number },
  options: CallOptions,
): Promise<Array<{ date: string; views: number }>> {
  const res = (await call(
    token,
    "GET",
    "/me/threads_insights",
    { metric: "views", since: params.sinceSec, until: params.untilSec },
    options,
  )) as { data?: InsightEntry[] };
  const entry = res.data?.[0];
  const out: Array<{ date: string; views: number }> = [];
  for (const v of entry?.values ?? []) {
    if (!v.end_time) continue;
    const date = v.end_time.slice(0, 10);
    out.push({ date, views: typeof v.value === "number" ? v.value : 0 });
  }
  return out;
}

/** URL別クリック（`link_total_values`）。SPEC §8.5 の週グリッドから1週ずつ呼ぶ。 */
export async function getLinkClicks(
  token: string,
  params: { sinceSec: number; untilSec: number },
  options: CallOptions,
): Promise<Array<{ url: string; clicks: number }>> {
  const res = (await call(
    token,
    "GET",
    "/me/threads_insights",
    { metric: "clicks", since: params.sinceSec, until: params.untilSec },
    options,
  )) as { data?: InsightEntry[] };
  const entry = res.data?.find((d) => d.link_total_values) ?? res.data?.[0];
  const out: Array<{ url: string; clicks: number }> = [];
  for (const v of entry?.link_total_values ?? []) {
    if (!v.link_url) continue;
    out.push({ url: v.link_url, clicks: typeof v.value === "number" ? v.value : 0 });
  }
  return out;
}

/** 現在のフォロワー数（since/until 不可）。 */
export async function getFollowersCount(
  token: string,
  options: CallOptions,
): Promise<number | null> {
  const res = (await call(
    token,
    "GET",
    "/me/threads_insights",
    { metric: "followers_count" },
    options,
  )) as { data?: InsightEntry[] };
  const entry = res.data?.[0];
  if (!entry) return null;
  const v = entry.total_value?.value ?? entry.values?.[0]?.value;
  return typeof v === "number" ? v : null;
}

/** フォロワー属性。フォロワー100人未満は失敗してよい（SPEC §6.3）。 */
export async function getDemographics(
  token: string,
  breakdown: string,
  options: CallOptions,
): Promise<unknown> {
  const res = (await call(
    token,
    "GET",
    "/me/threads_insights",
    { metric: "follower_demographics", breakdown },
    options,
  )) as { data?: unknown[] };
  return res.data?.[0] ?? null;
}

/** 残り枠（診断で表示。SPEC §6.3）。 */
export async function getPublishingLimit(
  token: string,
  options: CallOptions,
): Promise<{
  quota_usage?: number;
  config?: { quota_total?: number };
  reply_quota_usage?: number;
  reply_config?: { quota_total?: number };
} | null> {
  const res = (await call(
    token,
    "GET",
    "/me/threads_publishing_limit",
    { fields: "quota_usage,config,reply_quota_usage,reply_config" },
    options,
  )) as { data?: Array<Record<string, never>> };
  return (res.data?.[0] as never) ?? null;
}

/** リポスト（SPEC §7.3）。 */
export async function repost(
  token: string,
  mediaId: string,
  options: CallOptions,
): Promise<{ id: string }> {
  return (await call(token, "POST", `/${mediaId}/repost`, {}, options)) as { id: string };
}

/* ── 投稿（SPEC §6.3 / §8.3） ─────────────────────────
 * すべて `POST /me/threads` の使い分け。`auto_publish_text=true` を付けると
 * コンテナを作らずその場で公開され、応答の `{id}` が公開済み投稿IDになる。
 */

export type ReplyControl = "everyone" | "accounts_you_follow" | "mentioned_only";

export type CreateTextOptions = {
  /** ツリーの親（SPEC §8.3）。root には付けない */
  replyToId?: string | null;
  replyControl?: ReplyControl | null;
  /** 本文にリンクを置く設定のときだけ使う（SPEC §6.3） */
  linkAttachment?: string | null;
  /**
   * `true` ならコンテナを作らず即公開（1ステップ方式）。
   * `false` ならコンテナIDが返るので、`/{id}` で FINISHED を待って publish する（3ステップ方式）。
   */
  autoPublish: boolean;
};

/** テキスト投稿。`autoPublish` の値で1ステップ方式・3ステップ方式を切り替える。 */
export async function createTextPost(
  token: string,
  text: string,
  create: CreateTextOptions,
  options: CallOptions,
): Promise<{ id: string }> {
  const params: ThreadsParams = { media_type: "TEXT", text };
  if (create.autoPublish) params.auto_publish_text = true;
  if (create.replyToId) params.reply_to_id = create.replyToId;
  if (create.replyControl) params.reply_control = create.replyControl;
  if (create.linkAttachment) params.link_attachment = create.linkAttachment;
  return (await call(token, "POST", "/me/threads", params, options)) as { id: string };
}

/** 画像投稿のコンテナを作る（SPEC §6.3）。応答の `{id}` は creation_id。 */
export async function createImageContainer(
  token: string,
  imageUrl: string,
  text: string,
  create: Omit<CreateTextOptions, "autoPublish">,
  options: CallOptions,
): Promise<{ id: string }> {
  const params: ThreadsParams = { media_type: "IMAGE", image_url: imageUrl, text };
  if (create.replyToId) params.reply_to_id = create.replyToId;
  if (create.replyControl) params.reply_control = create.replyControl;
  return (await call(token, "POST", "/me/threads", params, options)) as { id: string };
}

export type ContainerStatus = {
  id?: string;
  status?: "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED" | string;
  error_message?: string | null;
};

/** コンテナの状態確認（SPEC §6.3 / §8.3 step 1）。 */
export async function getContainerStatus(
  token: string,
  containerId: string,
  options: CallOptions,
): Promise<ContainerStatus> {
  return (await call(
    token,
    "GET",
    `/${containerId}`,
    { fields: "status,error_message" },
    options,
  )) as ContainerStatus;
}

/** コンテナを公開する（SPEC §6.3）。応答の `{id}` が公開済み投稿ID。 */
export async function publishContainer(
  token: string,
  creationId: string,
  options: CallOptions,
): Promise<{ id: string }> {
  return (await call(
    token,
    "POST",
    "/me/threads_publish",
    { creation_id: creationId },
    options,
  )) as { id: string };
}

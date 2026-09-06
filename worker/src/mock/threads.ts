import { ThreadsApiError } from "../lib/threads-error";

/**
 * Threads API のモック（SPEC §11）。トークンが `THAAdemo` で始まるときだけ使う。
 *
 * このファイルは lib/threads.ts の DEV ガードの内側から動的 import される。
 * 本番ビルド（__DEV__=false）では import ごとデッドコード除去され、バンドルに入らない。
 *
 * 数字は投稿日からの経過時間で決まる決定的な擬似値。同じ入力なら常に同じ値になる。
 */

type MockPost = {
  id: string;
  text: string;
  permalink: string;
  timestamp: string;
  is_reply: boolean;
  root_id: string;
  replied_to_id: string | null;
  media_type: string;
  media_url: string | null;
  link_attachment_url: string | null;
};

type MockContainer = {
  id: string;
  text: string;
  replyToId: string | null;
  createdAt: number;
  polls: number;
  /** [[SLOW]] を含むコンテナは FINISHED にならない（container_polls の上限を試すため） */
  slow: boolean;
};

type MockStore = {
  user: { id: string; username: string; name: string; threads_profile_picture_url: string };
  posts: MockPost[];
  containers: Map<string, MockContainer>;
  seq: number;
  /** [[RATE]] を1回だけ跳ね返すために、既に跳ね返した本文を覚えておく */
  rateLimited: Set<string>;
};

/**
 * 本文に埋めるテスト用マーカー（SPEC §14 のジョブテスト用）。実 API には無い仕掛けで、
 * モックの中だけで効く。published される本文からは取り除く。
 *
 *   [[RATE]]  … その本文の初回だけ code 4（レート制限）で跳ね返す。2回目は通る
 *   [[FAIL]]  … 常に code 100 で跳ね返す（途中失敗 → 二重投稿しないことの確認）
 *   [[SLOW]]  … コンテナが FINISHED にならない（container_polls の上限を試す）
 */
export const MOCK_RATE_MARKER = "[[RATE]]";
export const MOCK_FAIL_MARKER = "[[FAIL]]";
export const MOCK_SLOW_MARKER = "[[SLOW]]";

function stripMarkers(text: string): string {
  return text
    .split(MOCK_RATE_MARKER)
    .join("")
    .split(MOCK_FAIL_MARKER)
    .join("")
    .split(MOCK_SLOW_MARKER)
    .join("")
    .trim();
}

const stores = new Map<string, MockStore>();

/** 決定的なハッシュ（文字列 → 0..1）。乱数は使わない。 */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const SEED_TEXTS = [
  "朝の30分だけで下書きを3本作る方法をまとめました。\nまずは机の上を片付けます。",
  "実は、伸びない投稿には共通点があります。\n1行目で誰に向けた話かを言っていません。",
  "副業を始めたい人へ。\n最初の1ヶ月は数字を見ないでください。",
  "これは危険なやり方です。\nフォロワーを買うと、表示回数だけが死にます。",
  "3つの型を回すだけで、投稿のネタ切れは止まります。",
  "私は半年間、毎日21時に投稿を続けてきました。\n分かったことを書きます。",
  "投稿を出す時間、決めてますか。\n決めていないなら、まず21時に固定してください。",
  "続きはコメントに置いています。",
  "リンクはこちら https://lin.ee/threadsdemo",
  "無料の型シートを配っています https://example.com/sheet?utm_source=threads",
];

function seedStore(token: string): MockStore {
  const suffix = token.slice("THAAdemo".length) || "0";
  const userId = `1780000000000${(hash01(suffix) * 900 + 100).toFixed(0)}`;
  const store: MockStore = {
    user: {
      id: userId,
      username: `demo_${suffix.slice(0, 6) || "user"}`,
      name: "デモアカウント",
      threads_profile_picture_url: "https://example.com/avatar.png",
    },
    posts: [],
    containers: new Map(),
    seq: 0,
    rateLimited: new Set(),
  };

  // 直近30日に root 10本 + そのうち3本に返信1本ずつ。時刻は固定（決定的）。
  const base = Date.UTC(2026, 8, 1, 12, 0, 0); // 2026-09-01T12:00:00Z
  for (let i = 0; i < 10; i++) {
    const at = new Date(base - i * 3 * 86400_000 + (i % 3) * 3600_000);
    const id = `${userId}${String(1000 + i)}`;
    store.posts.push({
      id,
      text: SEED_TEXTS[i % SEED_TEXTS.length]!,
      permalink: `https://www.threads.net/@${store.user.username}/post/${id}`,
      timestamp: at.toISOString(),
      is_reply: false,
      root_id: id,
      replied_to_id: null,
      media_type: "TEXT_POST",
      media_url: null,
      link_attachment_url: null,
    });
    if (i % 3 === 0) {
      const cid = `${userId}${String(2000 + i)}`;
      store.posts.push({
        id: cid,
        text: i % 2 === 0 ? "続きはこちら https://lin.ee/threadsdemo" : "詳しくは https://example.com/sheet",
        permalink: `https://www.threads.net/@${store.user.username}/post/${cid}`,
        timestamp: new Date(at.getTime() + 120_000).toISOString(),
        is_reply: true,
        root_id: id,
        replied_to_id: id,
        media_type: "TEXT_POST",
        media_url: null,
        link_attachment_url: null,
      });
    }
  }
  return store;
}

function storeFor(token: string): MockStore {
  let s = stores.get(token);
  if (!s) {
    s = seedStore(token);
    stores.set(token, s);
  }
  return s;
}

/** テスト用。全アカウントのモック状態を消す。 */
export function resetMock(): void {
  stores.clear();
}

export function isMockToken(token: string | undefined | null): boolean {
  return typeof token === "string" && token.startsWith("THAAdemo");
}

/** 投稿日からの経過時間で決まる擬似的な数字。 */
function metricsFor(post: MockPost, now: number) {
  const ageH = Math.max(0, (now - Date.parse(post.timestamp)) / 3600_000);
  const seed = hash01(post.id);
  // 48時間で 80% まで伸び、以後ゆっくり増える曲線
  const growth = 1 - Math.exp(-ageH / 24);
  const scale = post.is_reply ? 0.25 : 1;
  const views = Math.round((500 + seed * 4500) * growth * scale);
  const likes = Math.round(views * (0.01 + seed * 0.04));
  const replies = Math.round(likes * 0.12);
  const reposts = Math.round(likes * 0.06);
  const quotes = Math.round(likes * 0.02);
  const shares = Math.round(likes * 0.04);
  return { views, likes, replies, reposts, quotes, shares };
}

function insightsData(post: MockPost, now: number, metrics: string[]) {
  const m = metricsFor(post, now) as Record<string, number>;
  return {
    data: metrics
      .filter((name) => name in m)
      .map((name) => ({
        name,
        period: "lifetime",
        values: [{ value: m[name] }],
        title: name,
        id: `${post.id}/insights/${name}`,
      })),
  };
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

type Params = Record<string, string | undefined>;

export type MockRequest = {
  token: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  params: Params;
  /** テストで時刻を進めるための注入点 */
  now?: number;
};

/** モック側のエラーも本物と同じ ThreadsApiError で投げる（呼び出し側を分岐させない）。 */
function mockError(code: number, message: string): ThreadsApiError {
  return new ThreadsApiError({ code, message, raw: `#${code} ${message}` });
}

/**
 * `lib/threads.ts` の `call()` が使う唯一の入口。**デフォルトエクスポート**にしてあるのは、
 * 呼び出し側を `(await import("../mock/threads")).default(...)` と書けるようにするため。
 * 名前付きだと `__DEV__=false` のビルドで、消えた枝の中にその名前だけが文字列として残る。
 * 引数は call() のものをそのまま受け、正規化とエラー整形までここで済ませる。
 */
export function callMock(args: {
  token: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  params: Record<string, string | number | boolean | undefined | null>;
  now?: number;
}): unknown {
  const flat: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(args.params)) {
    if (v !== undefined && v !== null) flat[k] = String(v);
  }
  const req: MockRequest = {
    token: args.token,
    method: args.method,
    path: args.path,
    params: flat,
  };
  if (args.now !== undefined) req.now = args.now;
  return mockCall(req);
}

export default callMock;

/**
 * lib/threads.ts の call() と同じ引数を受け、Threads API と同じ形の JSON を返す。
 */
export function mockCall(req: MockRequest): unknown {
  const now = req.now ?? Date.now();

  // トークン失効（code 190）を再現する。`THAAdemo_expired…` を使うと needs_reauth の
  // 経路（SPEC §6.1 / §8.6）をテストできる
  if (req.token.includes("expired")) {
    throw mockError(190, "Error validating access token: Session has expired");
  }

  const store = storeFor(req.token);
  const path = req.path.startsWith("/") ? req.path : `/${req.path}`;
  const p = req.params;

  // ── トークン ──────────────────────────────────────
  if (path === "/access_token") {
    return { access_token: `${req.token}_long`, token_type: "bearer", expires_in: 5184000 };
  }
  if (path === "/refresh_access_token") {
    return { access_token: req.token, token_type: "bearer", expires_in: 5184000 };
  }

  // ── プロフィール ──────────────────────────────────
  if (path === "/me" && req.method === "GET") {
    return { ...store.user };
  }

  // ── 投稿一覧 ─────────────────────────────────────
  if (path === "/me/threads" && req.method === "GET") {
    const roots = store.posts
      .filter((x) => !x.is_reply)
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    return page(roots, p, store);
  }
  if (path === "/me/replies" && req.method === "GET") {
    const replies = store.posts
      .filter((x) => x.is_reply)
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    return page(replies, p, store);
  }

  // ── 投稿の作成 ────────────────────────────────────
  if (path === "/me/threads" && req.method === "POST") {
    const text = p.text ?? "";
    if ((text.match(/https?:\/\/\S+/g) ?? []).length > 5) {
      throw mockError(100, "THREADS_API__LINK_LIMIT_EXCEEDED: too many links");
    }
    if (text.includes(MOCK_FAIL_MARKER)) {
      throw mockError(100, "Invalid parameter: mock failure requested");
    }
    if (text.includes(MOCK_RATE_MARKER) && !store.rateLimited.has(text)) {
      store.rateLimited.add(text);
      throw mockError(4, "Application request limit reached");
    }
    const replyToId = p.reply_to_id ?? null;
    if (replyToId && !ensureKnownPost(store, replyToId, now)) {
      throw mockError(100, "Invalid parameter: reply_to_id not found");
    }
    const id = `${store.user.id}${String(9000 + store.seq++)}`;
    if (p.auto_publish_text === "true" && (p.media_type ?? "TEXT") === "TEXT") {
      publish(store, id, stripMarkers(text), replyToId, now);
      return { id };
    }
    // コンテナ作成（画像、または3ステップ方式のコメント）
    const slow = text.includes(MOCK_SLOW_MARKER) || (p.image_url ?? "").includes("slow");
    store.containers.set(id, { id, text: stripMarkers(text), replyToId, createdAt: now, polls: 0, slow });
    return { id };
  }
  if (path === "/me/threads_publish" && req.method === "POST") {
    const creationId = p.creation_id ?? "";
    const container = store.containers.get(creationId);
    if (!container) throw mockError(100, "Invalid parameter: creation_id not found");
    store.containers.delete(creationId);
    const id = `${store.user.id}${String(9000 + store.seq++)}`;
    publish(store, id, container.text, container.replyToId, now);
    return { id };
  }

  // ── アカウント単位のインサイト ───────────────────
  if (path === "/me/threads_insights" && req.method === "GET") {
    const metric = (p.metric ?? "views").split(",")[0]!;
    if (metric === "followers_count") {
      const n = 1200 + Math.floor((now - Date.UTC(2026, 0, 1)) / 86400_000) * 3;
      return { data: [{ name: "followers_count", period: "day", total_value: { value: n } }] };
    }
    if (metric === "follower_demographics") {
      return {
        data: [
          {
            name: "follower_demographics",
            total_value: {
              breakdowns: [
                {
                  dimension_keys: [p.breakdown ?? "age"],
                  results: [
                    { dimension_values: ["25-34"], value: 480 },
                    { dimension_values: ["35-44"], value: 360 },
                    { dimension_values: ["18-24"], value: 210 },
                  ],
                },
              ],
            },
          },
        ],
      };
    }
    if (metric === "clicks") {
      const since = Number(p.since ?? 0) * 1000;
      const until = Number(p.until ?? Math.floor(now / 1000)) * 1000;
      const totals = new Map<string, number>();
      for (const post of store.posts) {
        const t = Date.parse(post.timestamp);
        if (t < since || t > until) continue;
        for (const url of post.text.match(/https?:\/\/\S+/g) ?? []) {
          const clean = url.replace(/[。、，．,.!?！？)）」』】]+$/, "");
          const v = metricsFor(post, now).views;
          totals.set(clean, (totals.get(clean) ?? 0) + Math.round(v * 0.02));
        }
      }
      return {
        data: [
          {
            name: "clicks",
            period: "day",
            link_total_values: [...totals].map(([link_url, value]) => ({ link_url, value })),
          },
        ],
      };
    }
    // views（日別）
    const since = Number(p.since ?? Math.floor((now - 7 * 86400_000) / 1000)) * 1000;
    const until = Number(p.until ?? Math.floor(now / 1000)) * 1000;
    const values: Array<{ value: number; end_time: string }> = [];
    for (let t = since; t <= until; t += 86400_000) {
      values.push({
        value: 800 + Math.round(hash01(dayKey(t) + store.user.id) * 4000),
        end_time: new Date(t).toISOString(),
      });
    }
    return { data: [{ name: "views", period: "day", values }] };
  }

  if (path === "/me/threads_publishing_limit") {
    return {
      data: [
        {
          quota_usage: 3,
          config: { quota_total: 250, quota_duration: 86400 },
          reply_quota_usage: 5,
          reply_config: { quota_total: 1000, quota_duration: 86400 },
        },
      ],
    };
  }

  // ── /{id} 系 ─────────────────────────────────────
  const idMatch = /^\/([0-9A-Za-z_-]+)(\/(insights|repost))?$/.exec(path);
  if (idMatch) {
    const id = idMatch[1]!;
    const sub = idMatch[3];

    if (sub === "insights" && req.method === "GET") {
      const post = ensureKnownPost(store, id, now);
      if (!post) throw mockError(100, "Object with ID does not exist");
      const metrics = (p.metric ?? "views,likes,replies,reposts,quotes,shares").split(",");
      return insightsData(post, now, metrics);
    }

    if (sub === "repost" && req.method === "POST") {
      const post = ensureKnownPost(store, id, now);
      if (!post) throw mockError(100, "Object with ID does not exist");
      const newId = `${store.user.id}${String(9000 + store.seq++)}`;
      return { id: newId };
    }

    if (req.method === "DELETE") {
      const i = store.posts.findIndex((x) => x.id === id);
      if (i >= 0) store.posts.splice(i, 1);
      return { success: true };
    }

    if (req.method === "GET") {
      // コンテナの状態確認。1回目は IN_PROGRESS、2回目以降 FINISHED（ステップ実行の分岐を通す）
      const container = store.containers.get(id);
      if (container) {
        container.polls += 1;
        if (container.slow) return { id, status: "IN_PROGRESS" };
        return container.polls >= 2
          ? { id, status: "FINISHED" }
          : { id, status: "IN_PROGRESS" };
      }
      const post = ensureKnownPost(store, id, now);
      if (post) return { ...post, status: "PUBLISHED" };
      throw mockError(100, "Object with ID does not exist");
    }
  }

  throw mockError(100, `Unsupported mock path: ${req.method} ${path}`);
}

function publish(
  store: MockStore,
  id: string,
  text: string,
  replyToId: string | null,
  now: number,
): void {
  const parent = replyToId ? store.posts.find((x) => x.id === replyToId) : undefined;
  store.posts.push({
    id,
    text,
    permalink: `https://www.threads.net/@${store.user.username}/post/${id}`,
    timestamp: new Date(now).toISOString(),
    is_reply: Boolean(replyToId),
    root_id: parent ? parent.root_id : id,
    replied_to_id: replyToId,
    media_type: "TEXT_POST",
    media_url: null,
    link_attachment_url: null,
  });
}

/**
 * このストアが自分で発番したはずの ID を、消えていたら作り直す。
 *
 * モックの投稿はメモリ（＝Worker の isolate）にしか無い（SPEC §11）。`wrangler dev` は
 * ファイル変更やアイドルで isolate を捨てるので、5分ごとの cron をまたぐ処理
 * （ツリーのコメントは `commentDelaySec` 既定120秒あとの実行になる。SPEC §8.3）では
 * 前の実行で公開した投稿が消えていて `reply_to_id not found` になる。実 API では
 * 起こらない、モックだけの偽の失敗なので、ここで埋め戻す。
 *
 * 埋め戻すのは**このストアの発番規則に合う ID だけ**（`<user_id>` ＋ 4桁以上の数字）。
 * 取り違えた ID や空文字はこれまでどおりエラーになるので、`reply_to_id` を渡し忘れた
 * 実装の間違いは検出できる。
 */
function ensureKnownPost(store: MockStore, id: string, now: number): MockPost | undefined {
  const found = store.posts.find((x) => x.id === id);
  if (found) return found;
  const m = new RegExp(`^${store.user.id}(\\d{4,})$`).exec(id);
  if (!m) return undefined;
  // 発番カウンタを追い越しておく（同じ ID を二度出さない）
  const n = Number(m[1]);
  if (Number.isFinite(n) && n >= 9000) store.seq = Math.max(store.seq, n - 9000 + 1);
  publish(store, id, "（前の実行で公開した投稿）", null, now);
  return store.posts.find((x) => x.id === id);
}

function page(posts: MockPost[], p: Params, store: MockStore) {
  const limit = Math.min(Number(p.limit ?? 100) || 100, 100);
  const after = Number.parseInt(p.after ?? "0", 10) || 0;
  const slice = posts.slice(after, after + limit);
  const next = after + limit;
  return {
    data: slice.map((x) => ({
      id: x.id,
      text: x.text,
      permalink: x.permalink,
      timestamp: x.timestamp,
      is_reply: x.is_reply,
      media_type: x.media_type,
      media_url: x.media_url,
      link_attachment_url: x.link_attachment_url,
      is_quote_post: false,
      has_replies: posts.some((y) => y.replied_to_id === x.id),
      root_post: { id: x.root_id },
      replied_to: x.replied_to_id ? { id: x.replied_to_id } : undefined,
      owner: { id: store.user.id },
    })),
    paging: next < posts.length ? { cursors: { after: String(next) } } : {},
  };
}

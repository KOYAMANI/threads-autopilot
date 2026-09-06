/**
 * 参考情報の抽出（SPEC §10.4）。
 *
 * - `url`    … サーバーで fetch（UA はブラウザ風・10秒・最大2MB）。`<script>/<style>/<nav>/<footer>`
 *              を落とし、`<article>` か `<main>` があればそこを優先、無ければ `<p>` を連結。
 *              50,000文字で切る。失敗は `ExtractError`（画面は「本文を貼ってください」）
 * - `youtube` … URL を正規化（`v=` / `youtu.be/` / `shorts/`）。タイトルは oEmbed から。
 *              本文は取らない（Gemini には動画URLをそのまま渡す。§10.2）
 * - `file`   … ブラウザで読んで `content` として送るので、ここには来ない
 */

/** 本文の上限（SPEC §7.5「`content` は 50,000 文字で切る」）。 */
export const MAX_CONTENT_CHARS = 50_000;
/** 取得の上限（SPEC §10.4）。 */
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_FETCH_BYTES = 2 * 1024 * 1024;

/** ブラウザ風の UA（SPEC §10.4）。素の Worker の UA だと弾くサイトがある。 */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class ExtractError extends Error {
  readonly code = "EXTRACT_FAILED";
  constructor(message = "本文を取得できませんでした。本文を貼ってください") {
    super(message);
    this.name = "ExtractError";
  }
}

/** テストとモックのために fetch を差し替えられるようにする。 */
export type Fetcher = typeof fetch;

export type ExtractOptions = { fetchImpl?: Fetcher };

/* ── HTML → 本文 ───────────────────────────────────── */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** 中身を読む必要のないタグを丸ごと落とす。 */
function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1\s*>/gi, " ");
}

function tagsToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)\s*>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t　]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 最初に見つかった `<tag>…</tag>` の中身。入れ子は数えない（本文抽出には足りる）。 */
function firstBlock(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i");
  const m = re.exec(html);
  return m ? (m[1] ?? null) : null;
}

export function extractTitle(html: string): string {
  const t = firstBlock(html, "title");
  if (t) {
    const text = tagsToText(t).split("\n")[0]?.trim() ?? "";
    if (text !== "") return text.slice(0, 200);
  }
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (og?.[1]) return decodeEntities(og[1]).trim().slice(0, 200);
  return "";
}

/**
 * HTML から本文だけを取り出す（SPEC §10.4）。
 * `<article>` → `<main>` → `<p>` の連結、の順で優先する。50,000文字で切る。
 */
export function extractMainText(html: string): string {
  const cleaned = stripNoise(html);

  const article = firstBlock(cleaned, "article");
  if (article) {
    const text = tagsToText(article);
    if (text !== "") return text.slice(0, MAX_CONTENT_CHARS);
  }

  const main = firstBlock(cleaned, "main");
  if (main) {
    const text = tagsToText(main);
    if (text !== "") return text.slice(0, MAX_CONTENT_CHARS);
  }

  const paragraphs: string[] = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const text = tagsToText(m[1] ?? "");
    if (text !== "") paragraphs.push(text);
  }
  return paragraphs.join("\n\n").slice(0, MAX_CONTENT_CHARS);
}

/* ── 取得 ───────────────────────────────────────────── */

/** 2MB まで読む。超えたら打ち切って、そこまでを使う。 */
async function readCapped(res: Response): Promise<string> {
  const body = res.body;
  if (!body) return (await res.text()).slice(0, MAX_FETCH_BYTES);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (read >= MAX_FETCH_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  out += decoder.decode();
  return out;
}

/* ── 取りに行ってよい URL か（SSRF 対策） ─────────────── */

/**
 * 参考情報の `url` はユーザーが自由に入れられる。Worker はインターネット側にいるが、
 * `localhost` やプライベートIP、`file:` を渡されて内部に取りに行く形（SSRF）を作らない。
 * 名前解決の結果までは Workers から見られないので、URL の形で判定できる範囲を全部弾く。
 */
export const BLOCKED_URL_MESSAGE =
  "このURLは取得できません。公開されている記事のURLを入力してください";

/** ドット4つの IPv4 なら各オクテットを返す。違えば null。 */
function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5).map((s) => Number.parseInt(s, 10));
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** 公開インターネット上に無い IPv4 か（ループバック・私設・リンクローカル・共有・予約）。 */
function isPrivateIpv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, 127/8
  if (a === 169 && b === 254) return true; // 169.254/16 リンクローカル（メタデータ）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 ベンチマーク
  if (a >= 224) return true; // 224/4 マルチキャスト, 240/4 予約
  return false;
}

/** `[...]` を外した IPv6 リテラルが公開インターネット上に無いか。 */
function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase().split("%")[0] ?? "";
  if (h === "::1" || h === "::" || h === "") return true;
  if (/^f[cd]/.test(h)) return true; // fc00::/7 ユニークローカル
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 リンクローカル
  // IPv4 射影は IPv4 側の判定に回す。`URL` は `::ffff:127.0.0.1` を
  // `::ffff:7f00:1` に正規化するので、点表記と16進表記の両方を見る
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (dotted?.[1]) {
    const o = ipv4Octets(dotted[1]);
    return o ? isPrivateIpv4(o) : true;
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  }
  return false;
}

const BLOCKED_HOST_SUFFIX = [".localhost", ".local", ".internal", ".home.arpa"];

/**
 * 取りに行ってよい `http`/`https` の URL なら正規化して返す。
 * ダメなら `ExtractError`。リダイレクト先も毎回これを通す。
 */
export function assertFetchableUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new ExtractError(BLOCKED_URL_MESSAGE);
  }
  // `file:` `data:` `gopher:` `ftp:` などは全部落とす
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ExtractError(BLOCKED_URL_MESSAGE);
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "" || host === "localhost") throw new ExtractError(BLOCKED_URL_MESSAGE);
  if (BLOCKED_HOST_SUFFIX.some((s) => host.endsWith(s))) {
    throw new ExtractError(BLOCKED_URL_MESSAGE);
  }
  const octets = ipv4Octets(host);
  if (octets) {
    if (isPrivateIpv4(octets)) throw new ExtractError(BLOCKED_URL_MESSAGE);
  } else if (host.includes(":") || u.hostname.startsWith("[")) {
    if (isPrivateIpv6(u.hostname)) throw new ExtractError(BLOCKED_URL_MESSAGE);
  }
  return u;
}

export type ExtractedUrl = { title: string; content: string; url: string };

/** リダイレクトを自分で追う回数の上限。1ホップごとに `assertFetchableUrl` を通す。 */
const MAX_REDIRECTS = 3;

/** 記事URLから本文を取る（SPEC §10.4）。失敗は `ExtractError`。 */
export async function extractUrlSource(
  url: string,
  options: ExtractOptions = {},
): Promise<ExtractedUrl> {
  const doFetch = options.fetchImpl ?? fetch;
  // 入口で弾く。`redirect: "follow"` だと 302 で localhost に飛ばされても気づけないので、
  // リダイレクトは手で追い、毎ホップ同じ検査をかける。
  let target = assertFetchableUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    for (let hop = 0; ; hop++) {
      res = await doFetch(target.toString(), {
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
        signal: controller.signal,
        redirect: "manual",
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) throw new ExtractError();
      target = assertFetchableUrl(new URL(location, target).toString());
    }
  } catch (e) {
    throw e instanceof ExtractError ? e : new ExtractError();
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new ExtractError();

  const html = await readCapped(res).catch(() => {
    throw new ExtractError();
  });
  const content = extractMainText(html);
  if (content.trim() === "") throw new ExtractError();
  return { title: extractTitle(html) || url, content, url };
}

/* ── YouTube ────────────────────────────────────────── */

/**
 * YouTube の URL を `https://www.youtube.com/watch?v=<id>` に正規化する（SPEC §10.4）。
 * 受けるのは `watch?v=` / `youtu.be/<id>` / `shorts/<id>` の3形。
 * それ以外は null（＝YouTube として扱わない）。
 */
export function normalizeYoutubeUrl(input: string): string | null {
  const id = youtubeVideoId(input);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

export function youtubeVideoId(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const ok = (v: string | null | undefined): string | null =>
    v && /^[A-Za-z0-9_-]{6,20}$/.test(v) ? v : null;

  if (host === "youtu.be") return ok(u.pathname.slice(1).split("/")[0]);
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (u.pathname === "/watch") return ok(u.searchParams.get("v"));
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") {
      return ok(parts[1]);
    }
  }
  return null;
}

export type ExtractedYoutube = { title: string; url: string };

/** タイトルだけ oEmbed から取る。取れなくても失敗にしない（本文は使わないため）。 */
export async function extractYoutubeSource(
  input: string,
  options: ExtractOptions = {},
): Promise<ExtractedYoutube> {
  const url = normalizeYoutubeUrl(input);
  if (!url) throw new ExtractError("YouTube の URL として読めませんでした");

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await doFetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      { headers: { "User-Agent": BROWSER_UA }, signal: controller.signal },
    );
    if (res.ok) {
      const json = (await res.json()) as { title?: unknown };
      if (typeof json.title === "string" && json.title.trim() !== "") {
        return { title: json.title.trim().slice(0, 200), url };
      }
    }
  } catch {
    // タイトルが取れないだけ。URL は使える
  } finally {
    clearTimeout(timer);
  }
  return { title: url, url };
}

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

export type ExtractedUrl = { title: string; content: string; url: string };

/** 記事URLから本文を取る（SPEC §10.4）。失敗は `ExtractError`。 */
export async function extractUrlSource(
  url: string,
  options: ExtractOptions = {},
): Promise<ExtractedUrl> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
      redirect: "follow",
    });
  } catch {
    throw new ExtractError();
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

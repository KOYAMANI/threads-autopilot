/**
 * 参考情報の抽出（SPEC §10.4）。外部 fetch はスタブに差し替える（実 URL は叩かない）。
 */
import { describe, expect, it } from "vitest";
import {
  ExtractError,
  MAX_CONTENT_CHARS,
  extractMainText,
  extractTitle,
  extractUrlSource,
  extractYoutubeSource,
  normalizeYoutubeUrl,
  youtubeVideoId,
} from "../src/lib/extract";

/** 与えた本文で応答するスタブ。呼ばれた URL とヘッダも見られるようにする。 */
function stubFetch(
  body: string,
  init: { status?: number; contentType?: string } = {},
): { fn: typeof fetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((requestInit?.headers ?? {}) as Record<string, string>)) {
      headers[k] = v;
    }
    calls.push({ url: String(input), headers });
    return new Response(body, {
      status: init.status ?? 200,
      headers: { "Content-Type": init.contentType ?? "text/html; charset=utf-8" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("extractMainText（SPEC §10.4）", () => {
  it("<article> があればそこを優先する", () => {
    const html = `<html><body>
      <p>これは記事の外にある段落です。</p>
      <article><p>これが本文の1段落目です。</p><p>これが2段落目です。</p></article>
      <p>これも記事の外です。</p>
    </body></html>`;
    const text = extractMainText(html);
    expect(text).toContain("これが本文の1段落目です。");
    expect(text).toContain("これが2段落目です。");
    expect(text).not.toContain("記事の外");
  });

  it("<article> が無ければ <main> を使う", () => {
    const html = `<html><body><p>外</p><main><p>メインの本文です。</p></main></body></html>`;
    expect(extractMainText(html)).toBe("メインの本文です。");
  });

  it("どちらも無ければ <p> を連結する", () => {
    const html = `<html><body><p>1つ目。</p><p>2つ目。</p></body></html>`;
    expect(extractMainText(html)).toBe("1つ目。\n\n2つ目。");
  });

  it("script / style / nav / footer は落とす", () => {
    const html = `<html><body>
      <script>var secret = "スクリプトの中身";</script>
      <style>.x{content:"スタイルの中身"}</style>
      <nav><p>ナビの中身</p></nav>
      <footer><p>フッタの中身</p></footer>
      <article><p>残るのはここだけです。</p></article>
    </body></html>`;
    const text = extractMainText(html);
    expect(text).toBe("残るのはここだけです。");
  });

  it("50,000文字で切る", () => {
    const long = "あ".repeat(60_000);
    const html = `<article><p>${long}</p></article>`;
    expect(extractMainText(html).length).toBe(MAX_CONTENT_CHARS);
  });

  it("実体参照を戻す", () => {
    expect(extractMainText("<article><p>A&amp;B &lt;C&gt; &#65;</p></article>")).toBe("A&B <C> A");
  });
});

describe("extractTitle", () => {
  it("<title> を読む", () => {
    expect(extractTitle("<html><head><title>記事のタイトル</title></head></html>")).toBe(
      "記事のタイトル",
    );
  });

  it("<title> が無ければ og:title", () => {
    expect(
      extractTitle('<html><head><meta property="og:title" content="OGのタイトル"></head></html>'),
    ).toBe("OGのタイトル");
  });
});

describe("extractUrlSource（SPEC §10.4）", () => {
  it("ブラウザ風の UA を付けて取りに行き、本文とタイトルを返す", async () => {
    const { fn, calls } = stubFetch(
      "<html><head><title>取れた記事</title></head><body><article><p>本文が入っています。</p></article></body></html>",
    );
    const got = await extractUrlSource("https://example.com/a", { fetchImpl: fn });
    expect(got.title).toBe("取れた記事");
    expect(got.content).toBe("本文が入っています。");
    expect(calls[0]!.url).toBe("https://example.com/a");
    expect(calls[0]!.headers["User-Agent"]).toContain("Mozilla/5.0");
  });

  it("HTTP エラーは EXTRACT_FAILED", async () => {
    const { fn } = stubFetch("nope", { status: 500 });
    await expect(extractUrlSource("https://example.com/a", { fetchImpl: fn })).rejects.toThrow(
      ExtractError,
    );
  });

  it("本文が取れなかったら EXTRACT_FAILED", async () => {
    const { fn } = stubFetch("<html><body><div>段落のないページ</div></body></html>");
    await expect(extractUrlSource("https://example.com/a", { fetchImpl: fn })).rejects.toThrow(
      ExtractError,
    );
  });

  it("fetch 自体が失敗したら EXTRACT_FAILED", async () => {
    const fn = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const e = await extractUrlSource("https://example.com/a", { fetchImpl: fn }).catch((x) => x);
    expect(e).toBeInstanceOf(ExtractError);
    expect((e as ExtractError).code).toBe("EXTRACT_FAILED");
  });
});

describe("YouTube の URL 正規化（SPEC §10.4 の3形式）", () => {
  it("watch?v= / youtu.be/ / shorts/ の3つを同じ形にする", () => {
    const want = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    expect(normalizeYoutubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(want);
    expect(normalizeYoutubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(want);
    expect(normalizeYoutubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(want);
  });

  it("クエリや時刻が付いていても id だけを見る", () => {
    expect(normalizeYoutubeUrl("https://youtu.be/dQw4w9WgXcQ?t=42")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(normalizeYoutubeUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("YouTube でない URL は null", () => {
    expect(normalizeYoutubeUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(youtubeVideoId("ただの文字列")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/")).toBeNull();
  });

  it("oEmbed からタイトルを取る。取れなくても URL は返す", async () => {
    const { fn, calls } = stubFetch(JSON.stringify({ title: "動画のタイトル" }), {
      contentType: "application/json",
    });
    const got = await extractYoutubeSource("https://youtu.be/dQw4w9WgXcQ", { fetchImpl: fn });
    expect(got.title).toBe("動画のタイトル");
    expect(got.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(calls[0]!.url).toContain("youtube.com/oembed");

    const dead = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const fallback = await extractYoutubeSource("https://youtu.be/dQw4w9WgXcQ", {
      fetchImpl: dead,
    });
    expect(fallback.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(fallback.title).toBe(fallback.url);
  });

  it("YouTube として読めない URL は ExtractError", async () => {
    await expect(extractYoutubeSource("https://example.com/x")).rejects.toThrow(ExtractError);
  });
});

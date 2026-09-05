import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { call } from "../src/lib/threads";
import { createBudget } from "../src/lib/budget";
import { resetMock } from "../src/mock/threads";
import { redact, redactEmail, redactObject } from "../src/lib/redact";

const TOKEN = "THAAdemo_test";
const opts = () => ({ budget: createBudget({ subrequests: 100 }), env, now: Date.UTC(2026, 8, 4, 0, 0, 0) });

beforeEach(() => resetMock());

describe("モックモード（SPEC §11）", () => {
  it("/me が返る", async () => {
    const me = (await call(TOKEN, "GET", "/me", { fields: "id,username" }, opts())) as {
      id: string;
      username: string;
    };
    expect(me.id).toBeTruthy();
    expect(me.username).toMatch(/^demo_/);
  });

  it("投稿一覧が返り、返信は /me/replies 側に出る", async () => {
    const threads = (await call(TOKEN, "GET", "/me/threads", { limit: 100 }, opts())) as {
      data: Array<{ id: string; is_reply: boolean }>;
    };
    expect(threads.data.length).toBe(10);
    expect(threads.data.every((x) => !x.is_reply)).toBe(true);

    const replies = (await call(TOKEN, "GET", "/me/replies", { limit: 100 }, opts())) as {
      data: Array<{ is_reply: boolean }>;
    };
    expect(replies.data.length).toBeGreaterThan(0);
    expect(replies.data.every((x) => x.is_reply)).toBe(true);
  });

  it("POST /me/threads で投稿が増え、{id} が返る", async () => {
    const before = (await call(TOKEN, "GET", "/me/threads", { limit: 100 }, opts())) as { data: unknown[] };
    const created = (await call(
      TOKEN,
      "POST",
      "/me/threads",
      { media_type: "TEXT", text: "テスト投稿", auto_publish_text: true },
      opts(),
    )) as { id: string };
    expect(created.id).toBeTruthy();
    const after = (await call(TOKEN, "GET", "/me/threads", { limit: 100 }, opts())) as { data: unknown[] };
    expect(after.data.length).toBe(before.data.length + 1);
  });

  it("reply_to_id を付けるとツリーの2投稿目になる", async () => {
    const root = (await call(
      TOKEN,
      "POST",
      "/me/threads",
      { media_type: "TEXT", text: "本文", auto_publish_text: true },
      opts(),
    )) as { id: string };
    const child = (await call(
      TOKEN,
      "POST",
      "/me/threads",
      { media_type: "TEXT", text: "コメント https://lin.ee/x", reply_to_id: root.id, auto_publish_text: true },
      opts(),
    )) as { id: string };
    const replies = (await call(TOKEN, "GET", "/me/replies", { limit: 100 }, opts())) as {
      data: Array<{ id: string; root_post: { id: string } }>;
    };
    expect(replies.data.some((x) => x.id === child.id && x.root_post.id === root.id)).toBe(true);
  });

  it("リンク6本は LINK_LIMIT エラーになる", async () => {
    const text = Array.from({ length: 6 }, (_, i) => `https://e${i}.example`).join(" ");
    await expect(
      call(TOKEN, "POST", "/me/threads", { media_type: "TEXT", text, auto_publish_text: true }, opts()),
    ).rejects.toThrow(/LINK_LIMIT/);
  });

  it("insights は投稿日からの経過で増える決定的な数字を返す", async () => {
    const threads = (await call(TOKEN, "GET", "/me/threads", { limit: 1 }, opts())) as {
      data: Array<{ id: string }>;
    };
    const id = threads.data[0]!.id;
    const early = (await call(TOKEN, "GET", `/${id}/insights`, { metric: "views,likes" }, opts())) as {
      data: Array<{ name: string; values: Array<{ value: number }> }>;
    };
    const later = (await call(TOKEN, "GET", `/${id}/insights`, { metric: "views,likes" }, {
      ...opts(),
      now: Date.UTC(2026, 8, 20, 0, 0, 0),
    })) as { data: Array<{ name: string; values: Array<{ value: number }> }> };

    const v1 = early.data.find((d) => d.name === "views")!.values[0]!.value;
    const v2 = later.data.find((d) => d.name === "views")!.values[0]!.value;
    expect(v2).toBeGreaterThan(v1);

    // 同じ入力なら同じ値（決定的）
    const again = (await call(TOKEN, "GET", `/${id}/insights`, { metric: "views" }, opts())) as {
      data: Array<{ values: Array<{ value: number }> }>;
    };
    expect(again.data[0]!.values[0]!.value).toBe(v1);
  });

  it("clicks は本文中のURLに対して link_total_values を返す", async () => {
    const res = (await call(
      TOKEN,
      "GET",
      "/me/threads_insights",
      { metric: "clicks", since: 1712991600, until: Math.floor(Date.UTC(2026, 8, 4) / 1000) },
      opts(),
    )) as { data: Array<{ link_total_values: Array<{ link_url: string; value: number }> }> };
    const urls = res.data[0]!.link_total_values.map((x) => x.link_url);
    expect(urls).toContain("https://lin.ee/threadsdemo");
  });

  it("followers_count が total_value で返る", async () => {
    const res = (await call(TOKEN, "GET", "/me/threads_insights", { metric: "followers_count" }, opts())) as {
      data: Array<{ total_value: { value: number } }>;
    };
    expect(res.data[0]!.total_value.value).toBeGreaterThan(0);
  });

  it("コンテナは IN_PROGRESS → FINISHED → publish の3ステップを通せる", async () => {
    const container = (await call(
      TOKEN,
      "POST",
      "/me/threads",
      { media_type: "IMAGE", image_url: "https://example.com/a.png", text: "画像" },
      opts(),
    )) as { id: string };

    const first = (await call(TOKEN, "GET", `/${container.id}`, { fields: "status" }, opts())) as {
      status: string;
    };
    expect(first.status).toBe("IN_PROGRESS");
    const second = (await call(TOKEN, "GET", `/${container.id}`, { fields: "status" }, opts())) as {
      status: string;
    };
    expect(second.status).toBe("FINISHED");

    const published = (await call(
      TOKEN,
      "POST",
      "/me/threads_publish",
      { creation_id: container.id },
      opts(),
    )) as { id: string };
    expect(published.id).toBeTruthy();
  });

  it("subrequest 予算を数えている", async () => {
    const o = { budget: createBudget({ subrequests: 2 }), env };
    await call(TOKEN, "GET", "/me", {}, o);
    await call(TOKEN, "GET", "/me", {}, o);
    await expect(call(TOKEN, "GET", "/me", {}, o)).rejects.toThrow(/budget exceeded/);
  });
});

describe("redact（SPEC §2.4）", () => {
  it("クエリのトークンを伏せる", () => {
    expect(redact("https://graph.threads.net/v1.0/me?access_token=THAAdemo_secret&fields=id")).toBe(
      "https://graph.threads.net/v1.0/me?access_token=***&fields=id",
    );
  });
  it("Bearer と Cookie を伏せる", () => {
    expect(redact("Authorization: Bearer re_abcdef0123456789")).toContain("Bearer ***");
    expect(redact("Cookie: sid=abcdef; a=1")).toContain("sid=***");
  });
  it("よくあるAPIキーの見た目を伏せる", () => {
    expect(redact("key sk-abcdefghijklmn")).toBe("key sk-***");
    expect(redact("key AIzaAbCdEfGhIjKlMn")).toBe("key AIza***");
  });
  it("オブジェクトは秘密のキーごと伏せる", () => {
    expect(redactObject({ token: "abc", nested: { password: "x", ok: 1 } })).toEqual({
      token: "***",
      nested: { password: "***", ok: 1 },
    });
  });
  it("メールを部分的に伏せる", () => {
    expect(redactEmail("yamada@example.com")).toBe("y***@example.com");
    expect(redactEmail("broken")).toBe("***");
  });
});

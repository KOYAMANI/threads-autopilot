/**
 * AI 連携（SPEC §10）。外部 fetch はスタブ。実キーは使わない。
 * 実キーでの疎通は `docs/qa.md` M5 の手順（オーナー環境）で行う。
 */
import { describe, expect, it, vi } from "vitest";
import {
  AiError,
  buildContext,
  buildRequest,
  callAi,
  clipSources,
  readCandidates,
  readResponseText,
  stripJsonFence,
  systemPrompt,
  SOURCE_CHARS_EACH,
  SOURCE_CHARS_TOTAL,
} from "../src/lib/ai";

const BASE = {
  model: "gemini-2.5-flash",
  apiKey: "AIza-test-key-000",
  system: "システム",
  user: "ユーザー",
  appOrigin: "https://app.example.com",
} as const;

function geminiOk(text: string): Response {
  return Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
}
function openrouterOk(text: string): Response {
  return Response.json({ choices: [{ message: { content: text } }] });
}

const GOOD = JSON.stringify({
  candidates: [{ hook: "警告型", body: "本文です。", comments: ["コメント。"], basis: "根拠。" }],
});

/* ── リクエストの組み立て（SPEC §10.1） ─────────────── */

describe("buildRequest（SPEC §10.1）", () => {
  it("Gemini はキーをURLに含めずヘッダーへ付け、JSON 固定にする", () => {
    const plan = buildRequest({ ...BASE, provider: "gemini" });
    expect(plan.url).toContain(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(plan.url).not.toContain("key=");
    expect(new Headers(plan.init.headers).get("x-goog-api-key")).toBe(BASE.apiKey);
    const body = JSON.parse(String(plan.init.body));
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.systemInstruction.parts[0].text).toBe("システム");
    expect(body.contents[0].parts[0].text).toBe("ユーザー");
  });

  it("Gemini は YouTube を file_data として contents に足す（SPEC §10.2）", () => {
    const plan = buildRequest({
      ...BASE,
      provider: "gemini",
      youtubeUrls: ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    });
    const body = JSON.parse(String(plan.init.body));
    expect(body.contents[0].parts[1].file_data.file_uri).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("OpenRouter は chat/completions に Bearer・HTTP-Referer・X-Title を付ける", () => {
    const plan = buildRequest({
      ...BASE,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
    });
    expect(plan.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const h = plan.init.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer AIza-test-key-000");
    expect(h["HTTP-Referer"]).toBe("https://app.example.com");
    expect(h["X-Title"]).toBe("Threads Autopilot");
    const body = JSON.parse(String(plan.init.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]).toEqual({ role: "system", content: "システム" });
    expect(body.messages[1]).toEqual({ role: "user", content: "ユーザー" });
    // OpenRouter に YouTube は渡さない
    expect(String(plan.init.body)).not.toContain("file_data");
  });
});

/* ── 応答の解析（SPEC §10.1） ────────────────────────── */

describe("応答の解析（SPEC §10.1）", () => {
  it("Gemini と OpenRouter のどちらからも本文テキストを取り出す", () => {
    expect(readResponseText("gemini", { candidates: [{ content: { parts: [{ text: "あ" }] } }] })).toBe(
      "あ",
    );
    expect(readResponseText("openrouter", { choices: [{ message: { content: "い" } }] })).toBe("い");
  });

  it("形が違えば AI_BAD_OUTPUT", () => {
    expect(() => readResponseText("gemini", { nope: 1 })).toThrow(AiError);
    const e = (() => {
      try {
        readResponseText("openrouter", { choices: [] });
      } catch (x) {
        return x as AiError;
      }
    })()!;
    expect(e.code).toBe("AI_BAD_OUTPUT");
  });

  it("```json フェンスを剥がしてパースする", () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    const c = readCandidates("```json\n" + GOOD + "\n```", 3);
    expect(c[0]!.body).toBe("本文です。");
  });

  it("前後に説明文が付いていても { … } を切り出す", () => {
    const c = readCandidates(`はい、こちらです。\n${GOOD}\nご確認ください。`, 3);
    expect(c[0]!.hook).toBe("警告型");
  });

  it("JSON として読めなければ AI_BAD_OUTPUT", () => {
    const e = (() => {
      try {
        readCandidates("これはJSONではありません", 3);
      } catch (x) {
        return x as AiError;
      }
    })()!;
    expect(e).toBeInstanceOf(AiError);
    expect(e.code).toBe("AI_BAD_OUTPUT");
  });

  it("candidates が空・本文が空なら AI_BAD_OUTPUT", () => {
    expect(() => readCandidates(JSON.stringify({ candidates: [] }), 3)).toThrow(AiError);
    expect(() =>
      readCandidates(JSON.stringify({ candidates: [{ hook: "警告型", body: "" }] }), 3),
    ).toThrow(AiError);
  });

  it("案には A / B / C の key が順に付き、n 件で切る", () => {
    const three = JSON.stringify({
      candidates: [
        { hook: "警告型", body: "1", comments: [], basis: "" },
        { hook: "数字型", body: "2", comments: [], basis: "" },
        { hook: "疑問型", body: "3", comments: [], basis: "" },
        { hook: "断定型", body: "4", comments: [], basis: "" },
      ],
    });
    const c = readCandidates(three, 3);
    expect(c.map((x) => x.key)).toEqual(["A", "B", "C"]);
  });
});

/* ── タイムアウトとリトライ（SPEC §10.1） ────────────── */

describe("callAi（SPEC §10.1 タイムアウト60秒・1回リトライ）", () => {
  it("1回目が 500 でも2回目で成功すれば返る", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(geminiOk(GOOD));
    const raw = await callAi(
      { ...BASE, provider: "gemini" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(readCandidates(raw, 1)[0]!.body).toBe("本文です。");
  });

  it("2回とも失敗したら AI_FAILED（リトライは1回だけ）", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response("boom", { status: 500 }));
    const e = (await callAi(
      { ...BASE, provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    ).catch((x) => x)) as AiError;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(e.code).toBe("AI_FAILED");
  });

  it("応答の形が違うときも1回だけ引き直し、ダメなら AI_BAD_OUTPUT", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ nope: 1 }))
      .mockResolvedValueOnce(openrouterOk(GOOD));
    const raw = await callAi(
      { ...BASE, provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(readCandidates(raw, 1)[0]!.hook).toBe("警告型");

    const always = vi.fn().mockImplementation(async () => Response.json({ nope: 1 }));
    const e = (await callAi(
      { ...BASE, provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
      { fetchImpl: always as unknown as typeof fetch },
    ).catch((x) => x)) as AiError;
    expect(e.code).toBe("AI_BAD_OUTPUT");
  });

  it("タイムアウトすると AI_FAILED になり、日本語の理由が付く", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;

    const e = (await callAi(
      { ...BASE, provider: "gemini" },
      { fetchImpl, timeoutMs: 10, retries: 0 },
    ).catch((x) => x)) as AiError;
    expect(e.code).toBe("AI_FAILED");
    expect(e.message).toContain("60秒");
  });

  it("エラーの原文はキーを伏せてから持つ（redact）", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response("bad key: AIzaSyTHISLOOKSLIKEAKEY123", { status: 401 }));
    const e = (await callAi(
      { ...BASE, provider: "gemini" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    ).catch((x) => x)) as AiError;
    expect(e.raw).toContain("AIza***");
    expect(e.raw).not.toContain("AIzaSyTHISLOOKSLIKEAKEY123");
  });
});

/* ── プロンプト（SPEC §10.2 / §10.3） ────────────────── */

describe("buildContext / systemPrompt（SPEC §10.2 / §10.3）", () => {
  it("参考情報は各3,000字・合計9,000字までに切る", () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({
      title: `s${i}`,
      content: "あ".repeat(5_000),
    }));
    const clipped = clipSources(sources);
    const total = clipped.reduce((n, s) => n + s.content.length, 0);
    expect(total).toBeLessThanOrEqual(SOURCE_CHARS_TOTAL);
    expect(clipped[0]!.content.length).toBe(SOURCE_CHARS_EACH);
  });

  it("見本・リライト元・参考情報・リンク・指示・型の候補が入る", () => {
    const user = buildContext({
      templates: ["見本の本文。"],
      rewriteFrom: "リライトのもと。",
      sources: [{ title: "ソース1", content: "参考の中身。" }],
      youtubeUrls: ["https://www.youtube.com/watch?v=abcdefg"],
      links: [{ label: "LINE", url: "https://line.example.com" }],
      instruction: "初心者向けに。",
      n: 3,
    });
    expect(user).toContain("見本の本文。");
    expect(user).toContain("内容を保ったまま別の切り口で書き直す");
    expect(user).toContain("参考の中身。");
    expect(user).toContain("https://www.youtube.com/watch?v=abcdefg");
    expect(user).toContain("LINE: https://line.example.com");
    expect(user).toContain("初心者向けに。");
    expect(user).toContain("型を変えて3案");
    expect(user).toContain("呼びかけ型");
  });

  it("System は500文字・リンクの置き場所・NGワード・JSON固定を書く", () => {
    const s = systemPrompt({ linkPlacement: "comment", ngWords: "絶対\n必ず", emoji: "none" });
    expect(s).toContain("500文字以内");
    expect(s).toContain("リンクは コメント に置く");
    expect(s).toContain("絶対, 必ず");
    expect(s).toContain("絵文字は使わない");
    expect(s).toContain('"candidates"');
  });
});

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, insertAccount, mockToken, registerUser, testDb } from "./helpers";
import { createJobContext, enqueueJob, runJobs } from "../src/lib/jobs";
import { encrypt } from "../src/lib/crypto";
import { resetMock } from "../src/mock/threads";

beforeEach(() => resetMock());
afterEach(() => vi.unstubAllGlobals());

async function setup(suffix: string) {
  const user = await registerUser();
  const accountId = await insertAccount({ userId: user.userId, token: mockToken(suffix) });
  await api("PUT", "/api/ai/settings", {
    cookie: user.cookie,
    body: {
      acceptDataPolicy: true,
      geminiBillingConfirmed: true,
      provider: "gemini",
      key: "AIzaTESTKEY0123456789",
      storeOnServer: true,
    },
  });
  return { ...user, accountId };
}

describe("AI generation background tasks", () => {
  it("202で受け付け、暗号化した入力から3案を生成して取得できる", async () => {
    const user = await setup("background-1");
    const before = (env as { AI_MOCK?: string }).AI_MOCK;
    (env as { AI_MOCK?: string }).AI_MOCK = "1";
    try {
      const started = await api("POST", "/api/ai/generation-tasks", {
        cookie: user.cookie,
        body: { accountId: user.accountId, pickMode: "information", instruction: "朝の30分で下書きを作る方法", n: 3 },
      });
      expect(started.status).toBe(202);
      const taskId = started.body.data.taskId as string;
      const stored = await testDb().first<{ state_json: string }>("SELECT state_json FROM jobs WHERE id=?", taskId);
      expect(stored?.state_json).not.toContain("朝の30分");

      await runJobs(createJobContext(env), undefined, taskId);
      let completed = await api("GET", `/api/ai/generation-tasks/${taskId}`, { cookie: user.cookie });
      for (let attempt = 0; attempt < 20 && completed.body.data.status !== "done"; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        completed = await api("GET", `/api/ai/generation-tasks/${taskId}`, { cookie: user.cookie });
      }
      expect(completed.status).toBe(200);
      expect(completed.body.data.status).toBe("done");
      expect(completed.body.data.context.instruction).toBe("朝の30分で下書きを作る方法");
      expect(completed.body.data.result.candidates.map((candidate: { key: string }) => candidate.key)).toEqual(["A", "B", "C"]);
      expect(JSON.stringify(stored)).not.toContain("AIzaTESTKEY");
    } finally {
      (env as { AI_MOCK?: string }).AI_MOCK = before;
    }
  });

  it("他のユーザーのタスクは取得できず、未実行タスクは取り消せる", async () => {
    const owner = await setup("background-2");
    const other = await setup("background-3");
    const taskId = (await enqueueJob(createJobContext(env), "ai_generate", {
      accountId: owner.accountId,
      force: true,
      state: { inputEnc: await encrypt(JSON.stringify({ accountId: owner.accountId, pickMode: "information", instruction: "テスト投稿", n: 3 }), env.ENC_KEY) },
    }))!;
    expect(taskId).toBeTruthy();
    expect((await api("GET", `/api/ai/generation-tasks/${taskId}`, { cookie: other.cookie })).status).toBe(404);
    expect((await api("DELETE", `/api/ai/generation-tasks/${taskId}`, { cookie: owner.cookie })).status).toBe(200);
    const cancelled = await api("GET", `/api/ai/generation-tasks/${taskId}`, { cookie: owner.cookie });
    expect(cancelled.body.data.status).toBe("cancelled");
    expect(cancelled.body.data.error.code).toBe("CANCELLED");
  });

  it("Geminiの一時エラーは全体ジョブを再試行せず、すぐ失敗として返す", async () => {
    const user = await setup("background-503");
    const previous = (env as { AI_MOCK?: string }).AI_MOCK;
    (env as { AI_MOCK?: string }).AI_MOCK = "0";
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const started = await api("POST", "/api/ai/generation-tasks", {
        cookie: user.cookie,
        body: { accountId: user.accountId, pickMode: "information", instruction: "一時エラー確認", n: 3 },
      });
      const taskId = started.body.data.taskId as string;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const snapshot = await api("GET", `/api/ai/generation-tasks/${taskId}`, { cookie: user.cookie });
      expect(snapshot.body.data.status).toBe("failed");
      expect(snapshot.body.data.error.code).toBe("AI_FAILED");
      expect((await testDb().first<{ status: string }>("SELECT status FROM jobs WHERE id=?", taskId))?.status).toBe("done");
    } finally {
      (env as { AI_MOCK?: string }).AI_MOCK = previous;
    }
  });

  it("3.8の一時エラーを再試行しても選択したモデルを変えない", async () => {
    const user = await setup("background-fallback");
    await api("PUT", "/api/ai/settings", {
      cookie: user.cookie,
      body: { acceptDataPolicy: true, geminiBillingConfirmed: true, provider: "gemini", model: "gemini-3.8-flash", storeOnServer: true },
    });
    const previous = (env as { AI_MOCK?: string }).AI_MOCK;
    (env as { AI_MOCK?: string }).AI_MOCK = "0";
    const urls: string[] = [];
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request); urls.push(url);
      if (urls.length === 1) return Response.json({ error: { status: "UNAVAILABLE" } }, { status: 503 });
      const wire = JSON.parse(String(init?.body ?? "{}"));
      const userText = String(wire.contents?.[0]?.parts?.[0]?.text ?? "{}");
      const payload = JSON.parse(userText);
      const output = payload.task === "post-edit"
        ? { preparation: payload.preparation ?? "", candidates: payload.drafts, notes: [] }
        : { candidates: Array.from({ length: payload.n ?? 3 }, (_unused, index) => ({ posts: [`案${index + 1}の本文です。`] })), notes: [] };
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const started = await api("POST", "/api/ai/generation-tasks", {
        cookie: user.cookie,
        body: { accountId: user.accountId, pickMode: "information", instruction: "引っ越し準備", n: 3 },
      });
      const snapshot = await api("GET", `/api/ai/generation-tasks/${started.body.data.taskId}`, { cookie: user.cookie });
      expect(snapshot.body.data.status).toBe("done");
      expect(snapshot.body.data.result.candidates).toHaveLength(3);
      expect(snapshot.body.data.result.notes.join("\n")).not.toContain("軽量モデルへ切り替えて");
      expect(urls[0]).toContain("gemini-3.8-flash");
      expect(urls.every(url => url.includes("gemini-3.8-flash"))).toBe(true);
    } finally {
      (env as { AI_MOCK?: string }).AI_MOCK = previous;
    }
  });
});

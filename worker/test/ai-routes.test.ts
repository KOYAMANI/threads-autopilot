/**
 * `/api/sources` と `/api/ai` のルート（SPEC §7.5 / §7.6）。
 * AI 呼び出しは `AI_MOCK=1`（DEV ガード）で固定 JSON に差し替える。実キーは使わない。
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { classifyHook } from "@tap/shared";
import { api, insertAccount, mockToken, registerUser, testDb } from "./helpers";
import { topTemplates } from "../src/routes/ai";
import { resetMock } from "../src/mock/threads";

beforeEach(() => {
  resetMock();
});

/** AI_MOCK を有効にした env でアプリを叩く。`helpers.api` は env を直接使うので上書きする。 */
function withAiMock<T>(fn: () => Promise<T>): Promise<T> {
  const before = (env as { AI_MOCK?: string }).AI_MOCK;
  (env as { AI_MOCK?: string }).AI_MOCK = "1";
  return fn().finally(() => {
    (env as { AI_MOCK?: string }).AI_MOCK = before;
  });
}

async function setup(suffix: string) {
  const u = await registerUser();
  const accountId = await insertAccount({ userId: u.userId, token: mockToken(suffix) });
  return { ...u, accountId };
}

async function saveKey(
  cookie: string,
  options: { storeOnServer: boolean; key?: string; provider?: "gemini" | "openrouter" } = {
    storeOnServer: true,
  },
) {
  return api("PUT", "/api/ai/settings", {
    cookie,
    body: {
      provider: options.provider ?? "gemini",
      key: options.key ?? "AIzaTESTKEY0123456789",
      storeOnServer: options.storeOnServer,
    },
  });
}

/* ── 参考情報（SPEC §7.5） ──────────────────────────── */

describe("/api/sources（SPEC §7.5）", () => {
  it("text 型を作って一覧・編集・削除ができる", async () => {
    const { cookie } = await setup("src1");

    const created = await api("POST", "/api/sources", {
      cookie,
      body: { type: "text", title: "貼り付けたメモ", content: "参考にする本文です。" },
    });
    expect(created.status).toBe(201);
    expect(created.body.data.source.charCount).toBe("参考にする本文です。".length);

    const list = await api("GET", "/api/sources", { cookie });
    expect(list.body.data.sources).toHaveLength(1);
    expect(list.body.data.sources[0].contentPreview).toContain("参考にする本文");

    const id = created.body.data.source.id as string;
    const patched = await api("PATCH", `/api/sources/${id}`, {
      cookie,
      body: { title: "直したタイトル", enabledForAp: false },
    });
    expect(patched.body.data.source.title).toBe("直したタイトル");
    expect(patched.body.data.source.enabledForAp).toBe(false);

    const deleted = await api("DELETE", `/api/sources/${id}`, { cookie });
    expect(deleted.status).toBe(200);
    expect((await api("GET", "/api/sources", { cookie })).body.data.sources).toHaveLength(0);
  });

  it("本文が空の text は 400", async () => {
    const { cookie } = await setup("src2");
    const res = await api("POST", "/api/sources", {
      cookie,
      body: { type: "text", content: "   " },
    });
    expect(res.status).toBe(400);
  });

  it("他人の参考情報は見えないし触れない", async () => {
    const a = await setup("src3");
    const b = await setup("src4");
    const created = await api("POST", "/api/sources", {
      cookie: a.cookie,
      body: { type: "text", content: "Aさんのメモです。" },
    });
    const id = created.body.data.source.id as string;

    expect((await api("GET", "/api/sources", { cookie: b.cookie })).body.data.sources).toHaveLength(0);
    expect(
      (await api("PATCH", `/api/sources/${id}`, { cookie: b.cookie, body: { title: "x" } })).status,
    ).toBe(404);
    expect((await api("DELETE", `/api/sources/${id}`, { cookie: b.cookie })).status).toBe(404);
  });

  it("50,000文字で切る（SPEC §7.5）", async () => {
    const { cookie } = await setup("src5");
    const res = await api("POST", "/api/sources", {
      cookie,
      body: { type: "text", title: "長い本文", content: "あ".repeat(60_000) },
    });
    expect(res.body.data.source.charCount).toBe(50_000);
  });
});

/* ── AI 設定（SPEC §7.6 / §12.3 Settings） ──────────── */

describe("/api/ai/settings（SPEC §7.6）", () => {
  it("未設定なら hasKey=false・autopilotAvailable=false", async () => {
    const { cookie } = await setup("ai1");
    const res = await api("GET", "/api/ai/settings", { cookie });
    expect(res.body.data).toMatchObject({ provider: null, hasKey: false, autopilotAvailable: false });
  });

  it("サーバー保存なら hasKey=true・autopilotAvailable=true。キー本体は応答に出ない", async () => {
    const { cookie } = await setup("ai2");
    const res = await saveKey(cookie, { storeOnServer: true, key: "AIzaSECRETKEY0123456789" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      provider: "gemini",
      hasKey: true,
      storeOnServer: true,
      autopilotAvailable: true,
    });
    expect(JSON.stringify(res.body)).not.toContain("AIzaSECRETKEY0123456789");
    expect(res.body.data.model).toBe("gemini-2.5-flash");
  });

  it("端末保存への変更を拒否し、既存のサーバーキーを保持する", async () => {
    const { cookie, userId } = await setup("ai3");
    await saveKey(cookie, {storeOnServer:true,key:"test-server-key"});
    const before=await testDb().first<{key_enc:string}>("SELECT key_enc FROM ai_settings WHERE user_id=?",userId);
    expect((await saveKey(cookie,{storeOnServer:false,key:"test-client-key"})).status).toBe(400);
    expect((await testDb().first<{key_enc:string}>("SELECT key_enc FROM ai_settings WHERE user_id=?",userId))?.key_enc).toBe(before?.key_enc);
  });

  it("モデルだけ変えるときはサーバー保存のキーを消さない", async () => {
    const { cookie, userId } = await setup("ai4");
    await saveKey(cookie, { storeOnServer: true, key: "AIzaKEEPME0123456789" });
    const res = await api("PUT", "/api/ai/settings", {
      cookie,
      body: { provider: "gemini", model: "gemini-2.5-pro", storeOnServer: true },
    });
    expect(res.body.data.hasKey).toBe(true);
    expect(res.body.data.model).toBe("gemini-2.5-pro");
    const row = await testDb().first<{ key_enc: string | null }>(
      "SELECT key_enc FROM ai_settings WHERE user_id=?",
      userId,
    );
    expect(row?.key_enc).not.toBeNull();
  });

  it("他人の設定は見えない（ユーザーごとに独立）", async () => {
    const a = await setup("ai5");
    const b = await setup("ai6");
    await saveKey(a.cookie, { storeOnServer: true });
    const res = await api("GET", "/api/ai/settings", { cookie: b.cookie });
    expect(res.body.data.hasKey).toBe(false);
  });
});

/* ── 疎通（SPEC §7.6） ──────────────────────────────── */

describe("POST /api/ai/test（SPEC §7.6）", () => {
  it("キーがあれば {ok, model, latencyMs} を返す", async () => {
    const { cookie } = await setup("ait1");
    await saveKey(cookie, { storeOnServer: true });
    const res = await withAiMock(() => api("POST", "/api/ai/test", { cookie }));
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.model).toBe("gemini-2.5-flash");
    expect(typeof res.body.data.latencyMs).toBe("number");
  });

  it("キーが無ければ AI_KEY_REQUIRED", async () => {
    const { cookie } = await setup("ait2");
    const res = await withAiMock(() => api("POST", "/api/ai/test", { cookie }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("AI_KEY_REQUIRED");
  });
});

/* ── 生成（SPEC §7.6 / §10） ────────────────────────── */

describe("POST /api/ai/generate（SPEC §7.6）", () => {
  it("3案が返り、key は A / B / C（SPEC §7.6）", async () => {
    const { cookie, accountId } = await setup("aig1");
    await saveKey(cookie, { storeOnServer: true });
    const src = await api("POST", "/api/sources", {
      cookie,
      body: { type: "text", title: "朝の30分", content: "朝の30分で下書きを3本作る話。" },
    });

    const res = await withAiMock(() =>
      api("POST", "/api/ai/generate", {
        cookie,
        body: {
          accountId,
          sourceIds: [src.body.data.source.id],
          instruction: "初心者向けに。",
          n: 3,
        },
      }),
    );
    expect(res.status).toBe(200);
    const candidates = res.body.data.candidates as Array<{ key: string; body: string; basis: string }>;
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.key)).toEqual(["A", "B", "C"]);
    expect(candidates[0]!.body.length).toBeGreaterThan(0);
    expect(candidates[0]!.basis).toContain("朝の30分");
  });

  it("使った参考情報の last_used_at と use_count が進む（AP のローテーション用）", async () => {
    const { cookie, accountId } = await setup("aig2");
    await saveKey(cookie, { storeOnServer: true });
    const src = await api("POST", "/api/sources", {
      cookie,
      body: { type: "text", content: "使われるネタ源です。" },
    });
    const id = src.body.data.source.id as string;

    await withAiMock(() =>
      api("POST", "/api/ai/generate", { cookie, body: { accountId, sourceIds: [id] } }),
    );
    const row = await testDb().first<{ use_count: number; last_used_at: string | null }>(
      "SELECT use_count, last_used_at FROM sources WHERE id=?",
      id,
    );
    expect(row?.use_count).toBe(1);
    expect(row?.last_used_at).not.toBeNull();
  });

  it("clientKeyを使った生成を拒否する", async () => {
    const {cookie,accountId}=await setup("aig3");
    await saveKey(cookie);
    const result=await api("POST","/api/ai/generate",{cookie,body:{accountId,clientKey:"test-only-local-key"}});
    expect(result.status).toBe(400);
  });

  it("他人の accountId は 404", async () => {
    const a = await setup("aig4");
    const b = await setup("aig5");
    await saveKey(b.cookie, { storeOnServer: true });
    const res = await withAiMock(() =>
      api("POST", "/api/ai/generate", { cookie: b.cookie, body: { accountId: a.accountId } }),
    );
    expect(res.status).toBe(404);
  });

  it("OpenRouter に YouTube のネタ源を渡すと、貼り付けの案内が notes に入る（SPEC §10.2）", async () => {
    const { cookie, accountId, userId } = await setup("aig6");
    await saveKey(cookie, { storeOnServer: true, provider: "openrouter", key: "sk-or-TESTKEY0123" });
    // oEmbed を叩かずに youtube 行を作る（外部 fetch をしない）
    const sid = crypto.randomUUID();
    await testDb().run(
      `INSERT INTO sources (id, user_id, type, title, url, content, char_count, enabled_for_ap, last_used_at, use_count, created_at)
         VALUES (?,?,'youtube','動画のタイトル','https://www.youtube.com/watch?v=dQw4w9WgXcQ','',0,1,NULL,0,?)`,
      sid,
      userId,
      new Date().toISOString(),
    );

    const res = await withAiMock(() =>
      api("POST", "/api/ai/generate", { cookie, body: { accountId, sourceIds: [sid] } }),
    );
    expect(res.status).toBe(200);
    expect((res.body.data.notes as string[]).join()).toContain("文字起こし");
  });
});

/* ── 修正（SPEC §7.6） ──────────────────────────────── */

describe("POST /api/ai/revise（SPEC §7.6）", () => {
  it("1案だけが返り、key は元のまま", async () => {
    const { cookie, accountId } = await setup("air1");
    await saveKey(cookie, { storeOnServer: true });
    const res = await withAiMock(() =>
      api("POST", "/api/ai/revise", {
        cookie,
        body: {
          accountId,
          candidate: {
            key: "B",
            hook: "警告型",
            body: "直す前の本文です。",
            comments: ["コメント。"],
            basis: "根拠。",
          },
          instruction: "もっと短く。",
          history: [{ role: "user", text: "初心者向けに。" }],
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.data.candidate.key).toBe("B");
    expect(res.body.data.candidate.body).toContain("もっと短く。");
  });

  it("指示が空なら 400", async () => {
    const { cookie, accountId } = await setup("air2");
    await saveKey(cookie, { storeOnServer: true });
    const res = await withAiMock(() =>
      api("POST", "/api/ai/revise", {
        cookie,
        body: {
          accountId,
          candidate: { key: "A", hook: "警告型", body: "本文。", comments: [], basis: "" },
          instruction: "",
        },
      }),
    );
    expect(res.status).toBe(400);
  });
});

/* ── 文体の見本（SPEC §10.2「型が重ならないように上位3本」） ── */

describe("topTemplates（SPEC §10.2）", () => {
  it("表示回数の上位から、型が重ならないように3本だけ選ぶ", async () => {
    const { userId } = await registerUser();
    const accountId = await insertAccount({ userId, token: mockToken("tpl1") });
    const db = testDb();
    // views 降順で 警告型 / 警告型 / 疑問型 / 数字型 / 体験談型。
    // 型が重なる2本目を飛ばして 警告型・疑問型・数字型 の3本になるはず
    const rows: Array<[string, string, number]> = [
      ["p1", "これは危険です。やめてください。", 500],
      ["p2", "注意してください。損をします。", 400],
      ["p3", "本当にそれでいいですか？", 300],
      ["p4", "3つのコツを置いておきます", 200],
      ["p5", "私がやってみて分かったこと", 100],
    ];
    for (const [id, text, views] of rows) {
      await db.run(
        `INSERT INTO posts (account_id, id, root_id, is_reply, text, posted_at, views, tags_json, source)
           VALUES (?,?,?,0,?,?,?,'{}','external')`,
        accountId,
        id,
        id,
        text,
        new Date().toISOString(),
        views,
      );
    }
    const got = await topTemplates(db, accountId);
    expect(got).toHaveLength(3);
    expect(got.map(classifyHook)).toEqual(["警告型", "疑問型", "数字型"]);
    expect(new Set(got.map(classifyHook)).size).toBe(3);
  });

  it("返信と削除済みは見本にしない", async () => {
    const { userId } = await registerUser();
    const accountId = await insertAccount({ userId, token: mockToken("tpl2") });
    const db = testDb();
    await db.run(
      `INSERT INTO posts (account_id, id, root_id, is_reply, text, posted_at, views, tags_json, source)
         VALUES (?,'r1','p1',1,'これは返信です。',?,999,'{}','external'),
                (?,'d1','d1',0,'これは削除済みです。',?,998,'{}','external'),
                (?,'k1','k1',0,'これは残る本文です。',?,10,'{}','external')`,
      accountId,
      new Date().toISOString(),
      accountId,
      new Date().toISOString(),
      accountId,
      new Date().toISOString(),
    );
    await db.run("UPDATE posts SET deleted=1 WHERE account_id=? AND id='d1'", accountId);
    const got = await topTemplates(db, accountId);
    expect(got).toEqual(["これは残る本文です。"]);
  });
});


describe("rewrite input origins", () => {
  it("accepts a pasted tree and rejects mixing it with an owned post selection", async () => withAiMock(async () => {
    const { cookie, accountId } = await setup("rewrite-paste");
    await saveKey(cookie);
    const input = { accountId, pickMode: "rewrite", picks: [], referenceText: "【1投稿目】講座の準備はこの順番。\n【続き】生徒の悩みを聞く→目標を決める→試す。", instruction: "内容を保って簡潔に", n: 3 };
    const accepted = await api("POST", "/api/ai/generate", { cookie, body: input });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.candidates.length).toBeGreaterThan(0);
    expect((await api("POST", "/api/ai/generate", { cookie, body: { ...input, picks: ["another-id"] } })).status).toBe(400);
    expect((await api("POST", "/api/ai/generate", { cookie, body: { ...input, referenceText: "" } })).status).toBe(400);
  }));
});

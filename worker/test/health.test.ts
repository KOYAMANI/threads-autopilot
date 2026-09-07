import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, registerUser } from "./helpers";
import { mockAvailable, shouldUseMock, threadsReason } from "../src/lib/threads";

describe("GET /api/health（SPEC §7.8 / §11）", () => {
  it("{ok, version, mock} を返す", async () => {
    const res = await api("GET", "/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: "0.1.0", mock: true, environment:"local" });
  });

  it("THREADS_MOCK=0 なら mock は false", () => {
    expect(mockAvailable({ ...env, THREADS_MOCK: "0" })).toBe(false);
    expect(mockAvailable({ ...env, THREADS_MOCK: "1" })).toBe(true);
  });

  it("モックに入るのは THAAdemo トークンのときだけ", () => {
    expect(shouldUseMock(env, "THAAdemo_abc")).toBe(true);
    expect(shouldUseMock(env, "THQrealtoken")).toBe(false);
    expect(shouldUseMock({ ...env, THREADS_MOCK: "0" }, "THAAdemo_abc")).toBe(false);
  });

  it("未定義のルートは、未認証なら 401・認証済みなら NOT_FOUND", async () => {
    // 認証ミドルウェアがルーティングより先に走るので、未認証は存在の有無を漏らさない
    const anon = await api("GET", "/api/nope");
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe("UNAUTHORIZED");

    const u = await registerUser();
    const res = await api("GET", "/api/nope", { cookie: u.cookie });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("threadsReason（SPEC §6.2）", () => {
  const raw = "";
  it("権限不足", () => {
    expect(threadsReason({ code: 10, message: "permission denied", raw })).toContain(
      "threads_manage_insights",
    );
  });
  it("トークン失効", () => {
    expect(threadsReason({ code: 190, message: "expired", raw })).toContain("つなぎ直して");
  });
  it("レート制限", () => {
    for (const code of [4, 17, 32, 613]) {
      expect(threadsReason({ code, message: "rate", raw })).toContain("混み合っています");
    }
  });
  it("リンク上限", () => {
    expect(
      threadsReason({ code: 100, message: "THREADS_API__LINK_LIMIT_EXCEEDED", raw }),
    ).toContain("5つまで");
  });
  it("その他", () => {
    expect(threadsReason({ code: 999, message: "boom", raw })).toContain("受け付けませんでした");
  });
  it("必ず原文を末尾に付ける", () => {
    expect(threadsReason({ code: 190, message: "Session expired", raw })).toContain(
      "（Threadsからの返答: #190 Session expired）",
    );
  });
});

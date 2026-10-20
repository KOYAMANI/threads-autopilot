import { describe, expect, it } from "vitest";
import { redact, redactEmail, redactObject } from "../src/lib/redact";

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
  it("パスワード再設定トークン（?reset=）を伏せる", () => {
    expect(redact("https://app.example/login?reset=eyJhbGciOi.c2ln")).toBe(
      "https://app.example/login?reset=***",
    );
    expect(redact("/a/qaction?token=abc&x=1")).toContain("token=***");
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

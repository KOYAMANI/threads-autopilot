/**
 * Claude 連携（Remote MCP。DECISIONS「Claude 連携」）。
 *
 * claude.ai のカスタムコネクタと同じ順で叩く:
 *   動的クライアント登録 → /oauth/authorize（許可画面）→ 許可（既存ログインの Cookie）→ /oauth/token（PKCE）
 *   → /mcp の initialize / tools/list / tools/call
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { api, insertAccount, mockToken, registerUser, testDb } from "./helpers";
import { resetMock } from "../src/mock/threads";

const ORIGIN = "https://test.local";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

beforeEach(() => {
  resetMock();
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cookiePairs(res: Response): string[] {
  return res.headers.getSetCookie().map(c => c.split(";")[0]!);
}

async function registerClient(): Promise<string> {
  const res = await call("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

type Consent = { clientId: string; verifier: string; handle: string; cookies: string[]; html: string };

async function startConsent(): Promise<Consent> {
  const clientId = await registerClient();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    scope: "posts",
    resource: `${ORIGIN}/mcp`,
  });
  const res = await call(`/oauth/authorize?${q}`);
  const html = await res.text();
  expect(res.status).toBe(200);
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  return { clientId, verifier, handle: handle!, cookies: cookiePairs(res), html };
}

function submitConsent(consent: Consent, sid: string | null, decision = "approve"): Promise<Response> {
  return call("/oauth/authorize", {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: ORIGIN,
      Cookie: [...consent.cookies, ...(sid ? [sid] : [])].join("; "),
    },
    body: new URLSearchParams({ handle: consent.handle, decision }).toString(),
  });
}

/** 許可からトークン取得まで。返すのはアクセストークン。 */
async function connect(cookie: string): Promise<string> {
  const consent = await startConsent();
  const approved = await submitConsent(consent, cookie);
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get("Location")!);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("st-1");
  const code = location.searchParams.get("code")!;

  const token = await call("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: consent.clientId,
      code_verifier: consent.verifier,
      resource: `${ORIGIN}/mcp`,
    }).toString(),
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as { access_token: string; refresh_token?: string };
  expect(body.access_token).toBeTruthy();
  expect(body.refresh_token).toBeTruthy();
  return body.access_token;
}

let rpcId = 0;
async function rpc(token: string | null, method: string, params: unknown = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await call("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  let body: any = null;
  const data = text.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("");
  try {
    body = JSON.parse(data || text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const result = res.body.result;
  expect(result).toBeTruthy();
  return { isError: Boolean(result.isError), text: result.content.map((c: { text: string }) => c.text).join("\n") };
}

async function initialize(token: string) {
  return rpc(token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "1.0.0" },
  });
}

async function setupUser(suffix: string) {
  const u = await registerUser();
  const accountId = await insertAccount({ userId: u.userId, token: mockToken(suffix) });
  return { ...u, accountId };
}

describe("Claude 連携: OAuth", () => {
  it("メタデータを公開し、トークンなしの /mcp は 401 と resource_metadata を返す", async () => {
    const prm = await call("/.well-known/oauth-protected-resource/mcp");
    expect(prm.status).toBe(200);
    const prmBody = (await prm.json()) as { resource: string; authorization_servers: string[] };
    expect(prmBody.resource).toBe(`${ORIGIN}/mcp`);

    const as = await call("/.well-known/oauth-authorization-server");
    expect(as.status).toBe(200);
    const asBody = (await as.json()) as Record<string, unknown>;
    expect(asBody.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
    expect(asBody.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(asBody.code_challenge_methods_supported).toContain("S256");

    const res = await rpc(null, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("ログインしていないと許可できない。ログインしてから同じ画面で押し直せる", async () => {
    const u = await registerUser();
    const consent = await startConsent();
    expect(consent.html).toContain("Claude と連携しますか？");

    // ブラウザが Origin を送れるように（no-referrer だと同一オリジンの POST でも Origin: null になる）
    const page = await call(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: consent.clientId, redirect_uri: REDIRECT, code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s" })}`);
    expect(page.headers.get("Referrer-Policy")).toBe("same-origin");
    const foreignOrigin = await call("/oauth/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example", Cookie: [...consent.cookies, u.cookie].join("; ") },
      body: new URLSearchParams({ handle: consent.handle, decision: "approve" }).toString(),
    });
    expect(foreignOrigin.status).toBe(403);

    const noLogin = await submitConsent(consent, null);
    expect(noLogin.status).toBe(200);
    expect(await noLogin.text()).toContain("ログインしていません");

    const retry = await submitConsent(consent, u.cookie);
    expect(retry.status).toBe(302);
    expect(new URL(retry.headers.get("Location")!).searchParams.get("code")).toBeTruthy();
  });

  it("許可しないを押すと access_denied で claude.ai に戻る", async () => {
    const consent = await startConsent();
    const res = await submitConsent(consent, null, "deny");
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("許可は監査ログに claude_mcp として残る", async () => {
    const u = await registerUser();
    await connect(u.cookie);
    const row = await testDb().first<{ detail: string }>(
      "SELECT detail FROM audit_log WHERE user_id=? AND action='claude_mcp'",
      u.userId,
    );
    expect(JSON.parse(row!.detail)).toMatchObject({ event: "authorize" });
  });
});

describe("Claude 連携: 接続", () => {
  it("initialize と tools/list が通る", async () => {
    const u = await setupUser("init");
    const token = await connect(u.cookie);
    const init = await initialize(token);
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("threads-autopilot");
    const list = await rpc(token, "tools/list");
    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toContain("list_accounts");
    const accounts = await tool(token, "list_accounts");
    expect(JSON.parse(accounts.text).accounts[0]).toMatchObject({ account: "demo_test", timezone: "Asia/Tokyo" });
  });

  it("連携を解除するとトークンが使えなくなる", async () => {
    const u = await registerUser();
    const token = await connect(u.cookie);
    expect((await api("GET", "/api/claude/connection", { cookie: u.cookie })).body.data).toMatchObject({
      configured: true,
      connected: true,
      mcpUrl: `${ORIGIN}/mcp`,
    });

    const off = await api("DELETE", "/api/claude/connection", { cookie: u.cookie });
    expect(off.status).toBe(200);
    expect(off.body.data.revoked).toBeGreaterThan(0);
    expect((await rpc(token, "tools/list")).status).toBe(401);
    expect((await api("GET", "/api/claude/connection", { cookie: u.cookie })).body.data.connected).toBe(false);
  });

  it("接続の完了は、許可のあと claude.ai から initialize が届いた時点（他人の呼び出しでは完了しない）", async () => {
    const u = await registerUser();
    const other = await registerUser();
    const token = await connect(u.cookie);
    const otherToken = await connect(other.cookie);
    const status = async () => (await api("GET", "/api/claude/connection", { cookie: u.cookie })).body.data;

    // 許可しただけ: authorizedAt は入り、verifiedAt はまだ
    const before = await status();
    expect(before.connected).toBe(true);
    expect(before.authorizedAt).toBeTruthy();
    expect(before.verifiedAt).toBeNull();

    // 他人の initialize では完了しない
    expect((await initialize(otherToken)).status).toBe(200);
    expect((await status()).verifiedAt).toBeNull();

    // 本人の initialize で完了
    expect((await initialize(token)).status).toBe(200);
    const after = await status();
    expect(after.verifiedAt).toBeTruthy();
    expect(after.verifiedAt >= after.authorizedAt).toBe(true);

    // 解除すると両方 null に戻る
    await api("DELETE", "/api/claude/connection", { cookie: u.cookie });
    expect(await status()).toMatchObject({ connected: false, authorizedAt: null, verifiedAt: null });
  });

  it("ライセンスが失効したユーザーのトークンは弾く", async () => {
    const u = await registerUser();
    const token = await connect(u.cookie);
    await testDb().run("UPDATE licenses SET status='revoked' WHERE id=?", u.licenseId);
    expect((await rpc(token, "tools/list")).status).toBe(401);
  });


  it("退会したユーザーのトークンは弾く（KV の grant も取り消す）", async () => {
    const u = await registerUser();
    const token = await connect(u.cookie);
    const gone = await api("DELETE", "/api/users/me", { cookie: u.cookie, body: { password: "password1234" } });
    expect(gone.status).toBe(200);
    expect((await rpc(token, "tools/list")).status).toBe(401);
  });
});

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
import { api, countRows, insertAccount, mockToken, registerUser, testDb } from "./helpers";
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
    scope: "create",
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
  const source = await api("POST", "/api/sources", {
    cookie: u.cookie,
    body: { type: "text", title: "講座のメモ", content: "初めての講座づくりは、受講者の悩みを3つに絞るところから始める。" },
  });
  expect(source.status).toBe(201);
  return { ...u, accountId, sourceId: source.body.data.source.id as string };
}

async function createSession(u: { cookie: string; accountId: string; sourceId: string }) {
  const res = await api("POST", "/api/claude/sessions", {
    cookie: u.cookie,
    body: { accountId: u.accountId, pickMode: "information", sourceIds: [u.sourceId], instruction: "初めて講座を作る人向け" },
  });
  expect(res.status).toBe(200);
  expect(res.body.data.status).toBe("waiting");
  return res.body.data.id as string;
}

const GOOD = [
  { hook: "数字型", body: "講座づくりは悩みを3つに絞るだけ。\n\nそこから始めると迷わない。", comments: ["続きはプロフィールから"], basis: "講座のメモの冒頭" },
  { hook: "断定型", body: "最初の講座は、悩みを3つに絞れば作れる。", comments: [], basis: "講座のメモ" },
  { hook: "疑問型", body: "講座、何から作ればいい？\n\n答えは「悩みを3つに絞る」。", comments: [], basis: "講座のメモ" },
];

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

describe("Claude 連携: MCP ツール", () => {
  it("initialize と tools/list が通り、3つのツールが見える", async () => {
    const u = await registerUser();
    const token = await connect(u.cookie);
    const init = await initialize(token);
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe("threads-autopilot");

    const list = await rpc(token, "tools/list");
    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "get_create_session",
      "get_writing_guide",
      "save_candidates",
    ]);
  });

  it("get_create_session → save_candidates が通り、画面のポーリングに案が届く", async () => {
    const u = await setupUser("mcp1");
    const token = await connect(u.cookie);

    const none = await tool(token, "get_create_session");
    expect(none.isError).toBe(true);
    expect(none.text).toContain("Claude で作る");

    const sessionId = await createSession(u);
    const got = await tool(token, "get_create_session");
    expect(got.isError).toBe(false);
    const material = JSON.parse(got.text);
    expect(material.sessionId).toBe(sessionId);
    expect(material.pickMode).toBe("information");
    expect(material.sources[0].content).toContain("悩みを3つ");
    expect(material.instruction).toBe("初めて講座を作る人向け");
    expect(material.n).toBe(3);

    const guide = await tool(token, "get_writing_guide", { sessionId });
    const guideBody = JSON.parse(guide.text);
    expect(guideBody.system).toContain("あなたはThreads（Meta）の投稿を書く編集者です");
    expect(guideBody.outputFormat.candidates[0]).toHaveProperty("basis");

    const saved = await tool(token, "save_candidates", { sessionId, candidates: GOOD });
    expect(saved.isError).toBe(false);
    expect(saved.text).toContain("キューには入っていません");

    const poll = await api("GET", `/api/claude/sessions/${sessionId}`, { cookie: u.cookie });
    expect(poll.status).toBe(200);
    expect(poll.body.data.status).toBe("ready");
    expect(poll.body.data.candidates.map((c: { key: string }) => c.key)).toEqual(["A", "B", "C"]);
    expect(await countRows("queue", "account_id=?", u.accountId)).toBe(0);

    // 「Bだけ直して」: key を付けた1案だけ差し替わる
    const revised = await tool(token, "save_candidates", {
      sessionId,
      candidates: [{ key: "B", hook: "断定型", body: "講座は悩み3つから。", comments: [], basis: "短くした" }],
    });
    expect(revised.isError).toBe(false);
    const after = await api("GET", `/api/claude/sessions/${sessionId}`, { cookie: u.cookie });
    expect(after.body.data.candidates.map((c: { body: string }) => c.body)).toEqual([GOOD[0]!.body, "講座は悩み3つから。", GOOD[2]!.body]);

    const tools = await testDb().all<{ detail: string }>(
      "SELECT detail FROM audit_log WHERE user_id=? AND action='claude_mcp' ORDER BY at",
      u.userId,
    );
    expect(tools.map(r => JSON.parse(r.detail).tool ?? JSON.parse(r.detail).event)).toEqual(
      expect.arrayContaining(["authorize", "get_create_session", "get_writing_guide", "save_candidates"]),
    );
  });

  it("本文検証で NG の案があると、理由を返して1案も保存しない", async () => {
    const u = await setupUser("mcp2");
    const db = testDb();
    await db.run(
      "INSERT INTO autopilot (account_id, ng_words, link_placement, updated_at) VALUES (?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET ng_words=excluded.ng_words, link_placement=excluded.link_placement",
      u.accountId,
      "絶対稼げる",
      "comment",
      new Date().toISOString(),
    );
    const token = await connect(u.cookie);
    const sessionId = await createSession(u);

    const bad = await tool(token, "save_candidates", {
      sessionId,
      candidates: [
        { ...GOOD[0]!, body: "あ".repeat(501) },
        { ...GOOD[1]!, body: "詳しくは https://example.com を見て" },
        { ...GOOD[2]!, body: "これで絶対稼げる🔥" },
      ],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("保存していません");
    expect(bad.text).toContain("案A: 本文は500文字まで");
    expect(bad.text).toContain("案B: リンクはコメントに置く設定です");
    expect(bad.text).toMatch(/案C: .*絶対稼げる.*絵文字/);

    const poll = await api("GET", `/api/claude/sessions/${sessionId}`, { cookie: u.cookie });
    expect(poll.body.data.status).toBe("waiting");
    expect(poll.body.data.candidates).toEqual([]);

    // 1案だけ NG でも、残りの2案は保存されない
    const mixed = await tool(token, "save_candidates", { sessionId, candidates: [GOOD[0], GOOD[1], { ...GOOD[2]!, body: "" }] });
    expect(mixed.isError).toBe(true);
    const still = await api("GET", `/api/claude/sessions/${sessionId}`, { cookie: u.cookie });
    expect(still.body.data.candidates).toEqual([]);
  });
});

describe("Claude 連携: 分離", () => {
  it("他人のセッションは MCP からも画面の API からも読めず、書き込めない", async () => {
    const a = await setupUser("iso-a");
    const b = await setupUser("iso-b");
    const sessionA = await createSession(a);
    const tokenB = await connect(b.cookie);

    // B には自分のセッションが無い。A の最新を拾ってはいけない
    const latest = await tool(tokenB, "get_create_session");
    expect(latest.isError).toBe(true);
    expect(latest.text).not.toContain(sessionA);

    const byId = await tool(tokenB, "get_create_session", { sessionId: sessionA });
    expect(byId.isError).toBe(true);
    expect(byId.text).not.toContain("講座のメモ");

    const write = await tool(tokenB, "save_candidates", { sessionId: sessionA, candidates: GOOD });
    expect(write.isError).toBe(true);

    const guide = await tool(tokenB, "get_writing_guide", { sessionId: sessionA });
    expect(JSON.parse(guide.text).constraints).toEqual({ linkPlacement: "comment", ngWords: "", emoji: "none" });

    const pollB = await api("GET", `/api/claude/sessions/${sessionA}`, { cookie: b.cookie });
    expect(pollB.status).toBe(404);
    const pollA = await api("GET", `/api/claude/sessions/${sessionA}`, { cookie: a.cookie });
    expect(pollA.body.data.candidates).toEqual([]);

    // 他人のアカウントでセッションは作れない
    const foreign = await api("POST", "/api/claude/sessions", {
      cookie: b.cookie,
      body: { accountId: a.accountId, pickMode: "information", instruction: "x" },
    });
    expect(foreign.status).toBe(404);
  });

  it("他人の参考情報 ID を混ぜても読めない", async () => {
    const a = await setupUser("src-a");
    const b = await setupUser("src-b");
    const res = await api("POST", "/api/claude/sessions", {
      cookie: b.cookie,
      body: { accountId: b.accountId, pickMode: "information", sourceIds: [a.sourceId], instruction: "テーマ" },
    });
    expect(res.status).toBe(200);
    const token = await connect(b.cookie);
    const material = JSON.parse((await tool(token, "get_create_session")).text);
    expect(material.sources).toEqual([]);
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

  it("ライセンスが失効したユーザーのトークンは弾く", async () => {
    const u = await registerUser();
    const token = await connect(u.cookie);
    await testDb().run("UPDATE licenses SET status='revoked' WHERE id=?", u.licenseId);
    expect((await rpc(token, "tools/list")).status).toBe(401);
  });
});

describe("Claude 連携: 削除", () => {
  it("アカウント削除と退会で create_sessions も消える（外部キーの CASCADE）", async () => {
    const u = await setupUser("del-a");
    await createSession(u);
    const res = await api("DELETE", `/api/accounts/${u.accountId}`, { cookie: u.cookie });
    expect(res.status).toBe(200);
    expect(await countRows("create_sessions", "account_id=?", u.accountId)).toBe(0);

    const w = await setupUser("del-w");
    await createSession(w);
    const token = await connect(w.cookie);
    const gone = await api("DELETE", "/api/users/me", { cookie: w.cookie, body: { password: "password1234" } });
    expect(gone.status).toBe(200);
    expect(await countRows("create_sessions", "user_id=?", w.userId)).toBe(0);
    // 退会でトークンも取り消している
    expect((await rpc(token, "tools/list")).status).toBe(401);
  });
});

describe("POST /api/claude/sessions の検証", () => {
  it("材料が足りなければ claude.ai に行く前に断る", async () => {
    const u = await setupUser("val1");
    const empty = await api("POST", "/api/claude/sessions", { cookie: u.cookie, body: { accountId: u.accountId, pickMode: "information" } });
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toContain("参考情報");

    const template = await api("POST", "/api/claude/sessions", { cookie: u.cookie, body: { accountId: u.accountId, pickMode: "template", instruction: "x" } });
    expect(template.status).toBe(400);
  });
});

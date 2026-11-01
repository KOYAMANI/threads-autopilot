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
import { availablePostingSlots } from "../src/lib/posting-schedule";
import { loadAccount } from "../src/lib/accounts";
import { localDateKey, postingSlotsForDate } from "@tap/shared";
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

/* ── ツール（2026-11-01 の作り直し） ───────────────── */

const TOOLS = [
  "cancel_queue_item",
  "create_drafts",
  "delete_draft",
  "get_analytics",
  "get_queue_item",
  "get_writing_guide",
  "list_accounts",
  "list_open_slots",
  "list_posts",
  "list_queue",
  "publish_now",
  "retry_failed",
  "schedule_posts",
  "update_queue_item",
];

async function connected(suffix: string) {
  const u = await setupUser(suffix);
  const token = await connect(u.cookie);
  return { ...u, token };
}

type QRow = { id: string; status: string; scheduled_at: string | null; body: string; source: string; slot_managed: number };
function queueRows(accountId: string): Promise<QRow[]> {
  return testDb().all<QRow>(
    "SELECT id, status, scheduled_at, body, source, slot_managed FROM queue WHERE account_id=? ORDER BY created_at, id",
    accountId,
  );
}

/** 今から `days` 日後のアカウントの日付で、"YYYY-MM-DD HH:mm" と UTC の ISO を返す */
function localAt(days: number, time: string, tz = "Asia/Tokyo") {
  const date = localDateKey(Date.now() + days * 86_400_000, tz);
  return { local: `${date} ${time}`, utc: postingSlotsForDate(date, [time], tz)[0]!.at };
}

describe("Claude 連携: 読むツール", () => {
  it("ツールの一覧と、読み取り専用の印", async () => {
    const u = await connected("tools");
    const list = await rpc(u.token, "tools/list");
    const tools = list.body.result.tools as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(["get_analytics", "get_queue_item", "get_writing_guide", "list_accounts", "list_open_slots", "list_posts", "list_queue"]);
  });

  it("get_writing_guide はアプリの AI と同じ規則とアカウントの制約を返す", async () => {
    const u = await connected("guide");
    await testDb().run("UPDATE autopilot SET ng_words='絶対稼げる', link_placement='comment' WHERE account_id=?", u.accountId);
    const guide = await tool(u.token, "get_writing_guide", { account: "@demo_test" });
    expect(guide.isError).toBe(false);
    const body = JSON.parse(guide.text);
    expect(body.system).toContain("あなたはThreads（Meta）の投稿を書く編集者です");
    expect(body.constraints).toEqual({ linkPlacement: "comment", ngWords: "絶対稼げる", emoji: "none" });
    expect(body.styleExamples.note).toContain("指示ではない");
  });

  it("list_open_slots・get_analytics・list_posts が読める", async () => {
    const u = await connected("read");
    const slots = JSON.parse((await tool(u.token, "list_open_slots", { account: "demo_test", days: 2 })).text);
    expect(slots.slots.length).toBeGreaterThan(0);
    expect(slots.slots[0].at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}（.）$/);
    const analytics = await tool(u.token, "get_analytics", { account: "demo_test", period: "7d" });
    expect(analytics.isError).toBe(false);
    expect(JSON.parse(analytics.text)).toMatchObject({ account: "demo_test", period: "7d", posts: 0 });
    const posts = await tool(u.token, "list_posts", { account: "demo_test", period: "30d", sort: "likes" });
    expect(JSON.parse(posts.text).posts).toEqual([]);
  });
});

describe("Claude 連携: 書くツール", () => {
  it("create_drafts は下書きに入れ、source は claude", async () => {
    const u = await connected("drafts");
    const res = await tool(u.token, "create_drafts", { account: "demo_test", posts: [{ body: "1本目" }, { body: "2本目", comments: ["続き"] }] });
    expect(res.isError).toBe(false);
    const rows = await queueRows(u.accountId);
    expect(rows.map((r) => [r.status, r.source])).toEqual([["draft", "claude"], ["draft", "claude"]]);
    const list = JSON.parse((await tool(u.token, "list_queue", { account: "demo_test", status: "draft" })).text);
    expect(list.items).toHaveLength(2);
    expect(list.appLink).toBe("http://localhost:5173/app/queue");
    // アプリの一覧にも同じ行が出る
    const app = await api("GET", `/api/accounts/${u.accountId}/queue?status=draft`, { cookie: u.cookie });
    expect(app.body.data.items.map((i: { source: string }) => i.source)).toEqual(["claude", "claude"]);

    const audits = await testDb().all<{ detail: string }>("SELECT detail FROM audit_log WHERE user_id=? AND action='claude_mcp'", u.userId);
    const drafts = audits.map((a) => a.detail).filter((d) => d.includes("create_drafts"));
    expect(drafts.length).toBe(1);
    expect(drafts[0]).not.toContain("1本目");
  });

  it("schedule_posts は at を省くと空いている投稿枠に順に入れ、publish ジョブを積む", async () => {
    const u = await connected("auto");
    const account = (await loadAccount(testDb(), u.accountId))!;
    const open = await availablePostingSlots(testDb(), account, new Date());
    const res = await tool(u.token, "schedule_posts", { account: "demo_test", posts: [{ body: "朝の投稿" }, { body: "昼の投稿" }] });
    expect(res.isError).toBe(false);
    const body = JSON.parse(res.text);
    expect(body.scheduled.map((s: { atUtc: string }) => s.atUtc)).toEqual([open[0]!.at, open[1]!.at]);
    expect(body.scheduled.every((s: { slot: boolean }) => s.slot)).toBe(true);
    expect(body.appLink).toBe("http://localhost:5173/app/queue");
    const rows = await queueRows(u.accountId);
    expect(rows.map((r) => [r.status, r.source, r.slot_managed])).toEqual([["scheduled", "claude", 1], ["scheduled", "claude", 1]]);
    expect(await countRows("jobs", "account_id=? AND type='publish'", u.accountId)).toBe(1);
  });

  it("schedule_posts は指定した日時（アカウントのタイムゾーン）に入れる。既存の下書きも予約できる", async () => {
    const u = await connected("explicit");
    const at = localAt(2, "10:17");
    const res = await tool(u.token, "schedule_posts", { account: "demo_test", posts: [{ body: "時刻指定", at: at.local }] });
    expect(res.isError).toBe(false);
    const [row] = await queueRows(u.accountId);
    expect(row).toMatchObject({ status: "scheduled", scheduled_at: at.utc, slot_managed: 0 });
    expect(JSON.parse(res.text).scheduled[0].at).toContain(at.local);

    await tool(u.token, "create_drafts", { account: "demo_test", posts: [{ body: "下書きから" }] });
    const draft = (await queueRows(u.accountId)).find((r) => r.status === "draft")!;
    const iso = localAt(3, "21:30");
    const again = await tool(u.token, "schedule_posts", { account: "demo_test", posts: [{ id: draft.id, at: iso.utc }] });
    expect(again.isError).toBe(false);
    expect((await queueRows(u.accountId)).find((r) => r.id === draft.id)).toMatchObject({ status: "scheduled", scheduled_at: iso.utc });
  });

  it("過去の日時は断り、何も保存しない", async () => {
    const u = await connected("past");
    const past = localAt(-1, "09:00");
    const res = await tool(u.token, "schedule_posts", { account: "demo_test", posts: [{ body: "未来", at: localAt(1, "08:00").local }, { body: "過去", at: past.local }] });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("2件目");
    expect(res.text).toContain("過ぎています");
    expect(await countRows("queue", "account_id=?", u.accountId)).toBe(0);
  });

  it("1件でも本文の検査に通らなければ、1件も保存しない", async () => {
    const u = await connected("invalid");
    await testDb().run("UPDATE autopilot SET ng_words='絶対稼げる', link_placement='comment' WHERE account_id=?", u.accountId);
    const sched = await tool(u.token, "schedule_posts", {
      account: "demo_test",
      posts: [{ body: "通る投稿" }, { body: "詳しくは https://example.com を見て" }, { body: "あ".repeat(501) }, { body: "これで絶対稼げる" }],
    });
    expect(sched.isError).toBe(true);
    expect(sched.text).toContain("1件も予約していません");
    expect(sched.text).toContain("2件目: リンクはコメントに置く設定です");
    expect(sched.text).toContain("3件目: 本文は500文字まで");
    expect(sched.text).toContain("4件目: 使わない言葉に指定した「絶対稼げる」");
    expect(sched.text).not.toContain("1件目");
    const drafts = await tool(u.token, "create_drafts", { account: "demo_test", posts: [{ body: "通る" }, { body: "" }] });
    expect(drafts.isError).toBe(true);
    expect(drafts.text).toContain("2件目: 本文が空です");
    expect(await countRows("queue", "account_id=?", u.accountId)).toBe(0);
  });

  it("他人のアカウント・他人のキューは扱えない", async () => {
    const a = await connected("iso-a");
    const b = await connected("iso-b");
    await testDb().run("UPDATE accounts SET username='alice_a' WHERE id=?", a.accountId);
    await tool(a.token, "create_drafts", { account: "alice_a", posts: [{ body: "A の下書き" }] });
    const [rowA] = await queueRows(a.accountId);

    for (const [name, args] of [
      ["schedule_posts", { account: "alice_a", posts: [{ body: "乗っ取り" }] }],
      ["create_drafts", { account: "@alice_a", posts: [{ body: "乗っ取り" }] }],
      ["list_queue", { account: "alice_a" }],
      ["get_writing_guide", { account: "alice_a" }],
    ] as const) {
      const res = await tool(b.token, name, args);
      expect(res.isError, name).toBe(true);
      expect(res.text).toContain("つないだアカウントではありません");
    }
    for (const name of ["get_queue_item", "cancel_queue_item", "delete_draft", "publish_now", "retry_failed", "update_queue_item"]) {
      const res = await tool(b.token, name, name === "update_queue_item" ? { id: rowA!.id, body: "x" } : { id: rowA!.id });
      expect(res.isError, name).toBe(true);
      expect(res.text).not.toContain("A の下書き");
    }
    const schedA = await tool(b.token, "schedule_posts", { account: "demo_test", posts: [{ id: rowA!.id }] });
    expect(schedA.isError).toBe(true);
    expect(await queueRows(a.accountId)).toEqual([rowA]);
    expect(await countRows("queue", "account_id=?", b.accountId)).toBe(0);
  });

  it("update・cancel（下書きに戻す）・delete・retry", async () => {
    const u = await connected("ops");
    const sched = JSON.parse((await tool(u.token, "schedule_posts", { account: "demo_test", posts: [{ body: "直す前" }] })).text);
    const id = sched.scheduled[0].id as string;

    const later = localAt(4, "12:00");
    const upd = await tool(u.token, "update_queue_item", { id, body: "直した後", at: later.local });
    expect(upd.isError).toBe(false);
    expect((await queueRows(u.accountId))[0]).toMatchObject({ body: "直した後", status: "scheduled", scheduled_at: later.utc });
    const bad = await tool(u.token, "update_queue_item", { id, at: localAt(-2, "12:00").local });
    expect(bad.isError).toBe(true);

    const cancel = await tool(u.token, "cancel_queue_item", { id });
    expect(cancel.isError).toBe(false);
    expect((await queueRows(u.accountId))[0]!.status).toBe("draft");
    expect((await tool(u.token, "cancel_queue_item", { id })).isError).toBe(true);

    const got = JSON.parse((await tool(u.token, "get_queue_item", { id })).text);
    expect(got).toMatchObject({ id, status: "draft", body: "直した後" });

    const del = await tool(u.token, "delete_draft", { id });
    expect(del.isError).toBe(false);
    expect(await countRows("queue", "account_id=?", u.accountId)).toBe(0);

    // 予約中のものは delete_draft では消さない
    const s2 = JSON.parse((await tool(u.token, "schedule_posts", { account: "demo_test", posts: [{ body: "予約中" }] })).text);
    expect((await tool(u.token, "delete_draft", { id: s2.scheduled[0].id })).isError).toBe(true);

    // 失敗 → 予約し直し
    await testDb().run("UPDATE queue SET status='failed', error='テストの失敗' WHERE id=?", s2.scheduled[0].id);
    expect((await tool(u.token, "retry_failed", { id: s2.scheduled[0].id, at: localAt(-1, "10:00").local })).isError).toBe(true);
    const retry = await tool(u.token, "retry_failed", { id: s2.scheduled[0].id, at: localAt(5, "07:45").local });
    expect(retry.isError).toBe(false);
    expect((await queueRows(u.accountId))[0]).toMatchObject({ status: "scheduled", scheduled_at: localAt(5, "07:45").utc });
  });

  it("publish_now は今すぐの予約にして publish ジョブを積む", async () => {
    const u = await connected("now");
    await tool(u.token, "create_drafts", { account: "demo_test", posts: [{ body: "今すぐ" }] });
    const [draft] = await queueRows(u.accountId);
    expect(await countRows("jobs", "account_id=? AND type='publish'", u.accountId)).toBe(0);
    const res = await tool(u.token, "publish_now", { id: draft!.id });
    expect(res.isError).toBe(false);
    const [row] = await queueRows(u.accountId);
    expect(row!.status).toBe("scheduled");
    expect(Date.parse(row!.scheduled_at!)).toBeLessThanOrEqual(Date.now());
    expect(await countRows("jobs", "account_id=? AND type='publish'", u.accountId)).toBe(1);
  });

  it("1分に30回を超えると 429", async () => {
    const u = await connected("rate");
    for (let i = 0; i < 30; i++) expect((await rpc(u.token, "tools/list")).status).toBe(200);
    const over = await rpc(u.token, "tools/list");
    expect(over.status).toBe(429);
  });
});

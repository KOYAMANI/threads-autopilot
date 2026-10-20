/**
 * Remote MCP サーバー（claude.ai のカスタムコネクタ。DECISIONS「Claude 連携」）。
 *
 * アプリが Claude を呼ぶのではなく、利用者の Claude（claude.ai）がアプリを呼ぶ。
 * 認可は `@cloudflare/workers-oauth-provider`（OAuth 2.1 + PKCE + 動的クライアント登録、
 * トークンは KV `OAUTH_KV`）、MCP は `agents/mcp/server` の stateless な `createMcpHandler`。
 *
 * - `POST /mcp`                              … MCP（Streamable HTTP）。有効なアクセストークン必須
 * - `GET|POST /oauth/authorize`              … 許可画面。既存のログイン（Cookie `sid`）に橋渡しする
 * - `POST /oauth/token` / `POST /oauth/register` … ライブラリが処理
 * - `/.well-known/oauth-authorization-server` / `/.well-known/oauth-protected-resource` … 同上
 */
import {
  OAuthProvider,
  getOAuthApi,
  type OAuthHelpers,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { DEV, type Env } from "../env";
import { audit } from "../lib/audit";
import { budgetFromEnv, BudgetExceeded } from "../lib/budget";
import { createDb, type Db } from "../lib/db";
import { rateHit } from "../lib/rate";
import { redact } from "../lib/redact";
import { getSession, readCookie, SESSION_COOKIE } from "../lib/session";
import { consentPage } from "./consent";
import { buildMcpServer } from "./server";

export const MCP_ROUTE = "/mcp";
const AUTHORIZE = "/oauth/authorize";
const TOKEN = "/oauth/token";
const REGISTER = "/oauth/register";
/** 付与する権限は1つだけ（作成セッションの読み書き）。 */
export const MCP_SCOPE = "create";
/** MCP の呼び出し上限（1分あたり、`mcp:<user_id>`）。1回の「作って」で数回しか呼ばない */
const MCP_RATE_PER_MIN = 30;

type Props = { userId: string };
type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

export function isMcpPath(path: string): boolean {
  return path === MCP_ROUTE || path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-");
}

/**
 * MCP の公開 URL の origin。本番は `APP_ORIGIN` に固定する（Host ヘッダーに引きずられて
 * トークンの宛先がずれないように）。開発とテストはリクエストの origin（wrangler dev の 8787 など）。
 */
export function mcpOrigin(env: Env, request: Request): string {
  return DEV ? new URL(request.url).origin : env.APP_ORIGIN.replace(/\/+$/, "");
}

export function mcpConfigured(env: Env): boolean {
  return Boolean(env.OAUTH_KV);
}

async function userActive(db: Db, userId: string): Promise<boolean> {
  const row = await db.first<{ id: string }>(
    "SELECT u.id FROM users u JOIN licenses l ON l.id=u.license_id WHERE u.id=? AND l.status='active'",
    userId,
  );
  return row !== null;
}

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

/* ── MCP 本体（トークン検証済みのリクエストだけが来る） ─ */

async function serveMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const props = (ctx as ExecutionContext & { props?: Partial<Props> }).props;
  const userId = typeof props?.userId === "string" ? props.userId : null;
  const db = createDb(env.DB, budgetFromEnv(env));
  try {
    // 退会・ライセンス失効のあとに残ったトークンは、ここで弾く（KV のトークンは最長30日残る）
    if (!userId || !(await userActive(db, userId))) {
      const metadata = `${mcpOrigin(env, request)}/.well-known/oauth-protected-resource${MCP_ROUTE}`;
      return jsonRpcError(401, "連携が無効です。claude.ai のコネクタ設定から接続し直してください", {
        "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${metadata}"`,
      });
    }
    if (!(await rateHit(db, `mcp:${userId}`, MCP_RATE_PER_MIN, 1))) {
      return jsonRpcError(429, "呼び出しが多すぎます。1分ほど空けてからもう一度お試しください");
    }
    const handler = createMcpHandler(() => buildMcpServer({ db, userId }), {
      route: MCP_ROUTE,
      onerror: (e: unknown) => console.error(`[mcp] ${redact(String(e instanceof Error ? e.stack ?? e.message : e))}`),
    });
    return await handler(request, env, ctx);
  } catch (e) {
    if (e instanceof BudgetExceeded) return jsonRpcError(503, "処理が混み合っています。少し待ってからもう一度お試しください");
    console.error(`[mcp] unhandled: ${redact(String(e instanceof Error ? e.stack ?? e.message : e))}`);
    return jsonRpcError(500, "処理に失敗しました");
  }
}

/* ── 許可画面（既存ログインへの橋渡し） ─────────────── */

const RETRY = "claude.ai のコネクタ設定から、もう一度「接続」を押してください。";

async function authorize(request: Request, env: OAuthEnv): Promise<Response> {
  const helpers = env.OAUTH_PROVIDER;

  if (request.method === "GET") {
    let authRequest;
    try {
      authRequest = await helpers.parseAuthRequest(request);
    } catch {
      return consentPage(env, { status: 400, title: "接続の要求を読めませんでした", message: RETRY });
    }
    const consent = await helpers.describeConsent(authRequest);
    const tx = await helpers.beginConsent(authRequest);
    return consentPage(
      env,
      {
        status: 200,
        title: "Claude と連携しますか？",
        message: "許可すると、Claude がこのアプリの「作る」画面の材料を読み、案を書き戻せるようになります。",
        form: { handle: tx.handle, clientName: consent.clientName, redirectHost: consent.redirectHost, loopback: consent.redirectIsLoopback },
      },
      tx.headers,
    );
  }

  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // 許可画面からの送信だけを受ける（Origin が付くブラウザでは必ず照合する）
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    return consentPage(env, { status: 403, title: "この操作は受け付けられません", message: RETRY });
  }
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  const decision = String(form.get("decision") ?? "");

  try {
    if (decision !== "approve") {
      const denied = await helpers.denyConsent(request, handle);
      const headers = new Headers(denied.headers);
      headers.set("Location", denied.redirectTo);
      return new Response(null, { status: 302, headers });
    }

    const db = createDb(env.DB, budgetFromEnv(env));
    const sid = readCookie(request, SESSION_COOKIE);
    const session = sid ? await getSession(db, sid) : null;
    if (!session) {
      // handle はまだ使っていない。別タブでログインしてから、同じ画面でもう一度押せる
      return consentPage(env, {
        status: 200,
        title: "Claude と連携しますか？",
        message: "許可すると、Claude がこのアプリの「作る」画面の材料を読み、案を書き戻せるようになります。",
        form: { handle, clientName: "Claude", redirectHost: "—", loopback: false },
        warn: "このブラウザでアプリにログインしていません。下の「アプリを開く」からログインしてから、もう一度「許可する」を押してください。",
      });
    }
    if (!(await userActive(db, session.user_id))) {
      return consentPage(env, { status: 403, title: "ライセンスが有効ではありません", message: "ライセンスを確認してから、もう一度お試しください。" });
    }

    const approved = await helpers.approveConsent(request, handle, { scope: [MCP_SCOPE] });
    const { redirectTo } = await helpers.completeAuthorization({
      request: approved.request,
      userId: session.user_id,
      metadata: { connectedAt: new Date().toISOString() },
      scope: [MCP_SCOPE],
      props: { userId: session.user_id } satisfies Props,
    });
    await audit(db, session.user_id, "claude_mcp", { event: "authorize", clientId: approved.request.clientId });
    const headers = new Headers(approved.headers);
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (e) {
    // handle の期限切れ・二重送信・ブラウザの取り違え（AuthorizationError）
    console.error(`[mcp] authorize failed: ${redact(String(e instanceof Error ? e.message : e))}`);
    return consentPage(env, { status: 400, title: "許可の手続きが切れました", message: RETRY });
  }
}

/* ── 組み立て ─────────────────────────────────────── */

export function oauthOptions(origin: string): OAuthProviderOptions<Env> {
  return {
    apiRoute: MCP_ROUTE,
    apiHandler: { fetch: serveMcp as never },
    defaultHandler: {
      fetch: ((request: Request, env: OAuthEnv) =>
        new URL(request.url).pathname === AUTHORIZE ? authorize(request, env) : new Response("Not Found", { status: 404 })) as never,
    },
    authorizeEndpoint: AUTHORIZE,
    tokenEndpoint: TOKEN,
    clientRegistrationEndpoint: REGISTER,
    scopesSupported: [MCP_SCOPE],
    resourceMetadata: { resource: `${origin}${MCP_ROUTE}`, resource_name: "Threads オートパイロット" } as OAuthProviderOptions<Env>["resourceMetadata"],
  };
}

const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>(oauthOptions(origin));
    providers.set(origin, provider);
  }
  return provider;
}

/** `index.ts` から呼ぶ入口。`OAUTH_KV` が無い環境（未設定のデプロイ）では 503 を返す。 */
export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!mcpConfigured(env)) {
    return new Response(JSON.stringify({ error: "temporarily_unavailable", error_description: "Claude 連携はまだ設定されていません" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return providerFor(mcpOrigin(env, request)).fetch(request, env, ctx);
}

/** 設定画面の「連携を解除」と退会で使う。その人の許可を全部取り消す。 */
export async function revokeClaudeGrants(env: Env, request: Request, userId: string): Promise<number> {
  if (!mcpConfigured(env)) return 0;
  const api = getOAuthApi(oauthOptions(mcpOrigin(env, request)), env);
  let revoked = 0;
  let cursor: string | undefined;
  do {
    const page = await api.listUserGrants(userId, { cursor });
    for (const grant of page.items) {
      await api.revokeGrant(grant.id, userId);
      revoked++;
    }
    cursor = page.cursor;
  } while (cursor);
  return revoked;
}

export async function hasClaudeGrant(env: Env, request: Request, userId: string): Promise<boolean> {
  if (!mcpConfigured(env)) return false;
  const api = getOAuthApi(oauthOptions(mcpOrigin(env, request)), env);
  return (await api.listUserGrants(userId, { limit: 1 })).items.length > 0;
}

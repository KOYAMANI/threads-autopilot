/**
 * Claude 連携の画面側（DECISIONS「Claude 連携」）。MCP 本体は `mcp/index.ts`。
 *
 * - `POST   /claude/sessions`      … 「Claude で作る」。材料を検証して `create_sessions` に1行
 * - `GET    /claude/sessions/:id`  … 待機中のポーリング。Claude が書き戻した案を返す
 * - `GET    /claude/connection`    … Claude 連携の画面（URL・接続状態・許可と最後に呼ばれた時刻）
 * - `DELETE /claude/connection`    … 連携を解除（claude.ai に渡したトークンを全部取り消す）
 */
import { Hono } from "hono";
import { ok, type ClaudeConnectionResponse } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { loadOwnedAccount } from "../lib/accounts";
import { audit } from "../lib/audit";
import { hasClaudeGrant, MCP_ROUTE, mcpConfigured, mcpOrigin, revokeClaudeGrants } from "../mcp";
import { insertCreateSession, loadCreateSession, sessionPayloadSchema, toSessionResponse } from "../mcp/sessions";
import { loadGenerationMaterial } from "./ai";

export function claudeRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/sessions", async (c) => {
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = sessionPayloadSchema.safeParse(body);
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const input = parsed.data;
    const db = c.get("db");
    const userId = c.get("userId")!;

    const account = await loadOwnedAccount(db, input.accountId, userId);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    // Gemini の「生成する」と同じ判定。ここで弾けば、claude.ai に行ってから材料不足に気づくことが無い
    const material = await loadGenerationMaterial(db, userId, account.id, input);
    if (!material.ok) return fail(material.code, material.message, material.status);
    if (material.pickMode !== "rewrite" && !material.sourceRows.length && !input.instruction?.trim()) {
      return fail("BAD_REQUEST", "新しく書くテーマと、その内容がわかる参考情報を追加してください", 400);
    }

    const row = await insertCreateSession(db, userId, { ...input, pickMode: material.pickMode, picks: material.picks });
    return c.json(ok(toSessionResponse(row)));
  });

  r.get("/sessions/:id", async (c) => {
    const row = await loadCreateSession(c.get("db"), c.get("userId")!, c.req.param("id"));
    if (!row) return fail("NOT_FOUND", "見つかりませんでした", 404);
    return c.json(ok(toSessionResponse(row)));
  });

  r.get("/connection", async (c) => {
    const userId = c.get("userId")!;
    const connected = await hasClaudeGrant(c.env, c.req.raw, userId);
    // 許可（authorize）と、claude.ai から実際に呼ばれた時刻（initialize かツール）。audit_log から1クエリで引く
    const row = connected
      ? await c.get("db").first<{ authorized_at: string | null; used_at: string | null }>(
          `SELECT
             (SELECT MAX(at) FROM audit_log WHERE user_id=? AND action='claude_mcp'
                AND json_extract(detail,'$.event')='authorize') AS authorized_at,
             (SELECT MAX(at) FROM audit_log WHERE user_id=? AND action='claude_mcp'
                AND (json_extract(detail,'$.event')='initialize' OR json_extract(detail,'$.tool') IS NOT NULL)) AS used_at`,
          userId,
          userId,
        )
      : null;
    const authorizedAt = row?.authorized_at ?? null;
    // 許可より前の呼び出し（解除する前の古い接続）は数えない
    const usedAt = row?.used_at && authorizedAt && row.used_at >= authorizedAt ? row.used_at : null;
    const data: ClaudeConnectionResponse = {
      configured: mcpConfigured(c.env),
      connected,
      authorizedAt,
      verifiedAt: usedAt,
      mcpUrl: `${mcpOrigin(c.env, c.req.raw)}${MCP_ROUTE}`,
    };
    return c.json(ok(data));
  });

  r.delete("/connection", async (c) => {
    const userId = c.get("userId")!;
    const revoked = await revokeClaudeGrants(c.env, c.req.raw, userId);
    await audit(c.get("db"), userId, "claude_mcp", { event: "disconnect", revoked });
    return c.json(ok({ revoked }));
  });

  return r;
}

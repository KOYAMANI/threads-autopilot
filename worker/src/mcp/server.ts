/**
 * MCP ツール（DECISIONS「Claude 連携」）。既存の lib を呼ぶ薄いラッパーだけを置く。
 *
 * 1リクエスト＝1サーバー（stateless）。`userId` は OAuth の props から来たものだけを使う。
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { APP_VERSION } from "../env";
import { ACCOUNT_COLUMNS, ACCOUNT_ORDER_BY, type AccountRow } from "../lib/accounts";
import { audit } from "../lib/audit";
import { loadPostingSchedule } from "../lib/posting-schedule";
import type { McpRequestContext } from "./index";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(value: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

export function buildMcpServer(ctx: McpRequestContext): McpServer {
  const { db, userId } = ctx;
  const server = new McpServer(
    { name: "threads-autopilot", version: APP_VERSION },
    { instructions: "スレメイト（Threads の分析・予約投稿アプリ）と連携します。" },
  );

  server.registerTool(
    "list_accounts",
    {
      title: "アカウントの一覧",
      description: "このアプリにつないだ Threads アカウント（ユーザー名・タイムゾーン・投稿枠の時刻）を返します。",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const rows = await db.all<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS.split(", ").map((c) => `a.${c}`).join(", ")} FROM accounts a WHERE a.user_id=? ORDER BY ${ACCOUNT_ORDER_BY}`,
        userId,
      );
      const accounts = [];
      for (const a of rows) {
        const schedule = await loadPostingSchedule(db, a);
        accounts.push({ account: a.username, timezone: a.timezone, postingSlots: schedule.times });
      }
      await audit(db, userId, "claude_mcp", { tool: "list_accounts" });
      return text({ accounts });
    },
  );

  return server;
}

/** One-way managed exports. User-created tabs/columns are never overwritten. No credentials in cells. */
import type { JobContext, RunningJob } from "../lib/jobs";
import { BudgetExceeded } from "../lib/budget";
import {
  googleAccess,
  googleConfigured,
  googleHeaders,
  googleRequest,
  GoogleError,
} from "../lib/google";

export const SHEET_TABS = [
  {
    title: "投稿実績",
    headers: [
      "ID",
      "アカウント",
      "投稿ID",
      "投稿日時",
      "本文",
      "URL",
      "閲覧数",
      "いいね",
      "返信",
      "リポスト",
      "引用",
      "数値取得日時",
    ],
    sql: `SELECT a.id||':'||p.id AS cursor,a.username,p.id,p.posted_at,p.text,p.permalink,p.views,p.likes,p.replies,p.reposts,p.quotes,p.metrics_fetched_at
      FROM posts p JOIN accounts a ON a.id=p.account_id WHERE a.user_id=? AND p.deleted=0 AND a.id||':'||p.id>? ORDER BY cursor LIMIT 201`,
    fields: [
      "cursor",
      "username",
      "id",
      "posted_at",
      "text",
      "permalink",
      "views",
      "likes",
      "replies",
      "reposts",
      "quotes",
      "metrics_fetched_at",
    ],
  },
  {
    title: "分析",
    headers: ["ID", "アカウント", "日付", "閲覧数", "フォロワー数"],
    sql: `SELECT a.id||':'||d.date AS cursor,a.username,d.date,d.views,f.followers FROM daily_views d JOIN accounts a ON a.id=d.account_id
      LEFT JOIN follower_snapshots f ON f.account_id=d.account_id AND f.date=d.date WHERE a.user_id=? AND a.id||':'||d.date>? ORDER BY cursor LIMIT 201`,
    fields: ["cursor", "username", "date", "views", "followers"],
  },
  {
    title: "下書き",
    headers: ["ID", "アカウント", "本文", "コメント", "更新日時"],
    sql: `SELECT q.id AS cursor,a.username,q.body,q.comments_json,q.updated_at FROM queue q JOIN accounts a ON a.id=q.account_id
      WHERE a.user_id=? AND q.status='draft' AND q.id>? ORDER BY q.id LIMIT 201`,
    fields: ["cursor", "username", "body", "comments_json", "updated_at"],
  },
  {
    title: "参考情報",
    headers: ["ID", "種類", "タイトル", "URL", "本文", "自動運用で使用"],
    sql: `SELECT id AS cursor,type,title,url,content,enabled_for_ap FROM sources WHERE user_id=? AND id>? ORDER BY id LIMIT 201`,
    fields: ["cursor", "type", "title", "url", "content", "enabled_for_ap"],
  },
  {
    title: "予約・実行結果",
    headers: [
      "ID",
      "アカウント",
      "状態",
      "予約日時",
      "本文",
      "コメント",
      "投稿結果ID",
      "更新日時",
    ],
    sql: `SELECT q.id AS cursor,a.username,q.status,q.scheduled_at,q.body,q.comments_json,q.result_ids_json,q.updated_at FROM queue q JOIN accounts a ON a.id=q.account_id
      WHERE a.user_id=? AND q.status<>'draft' AND q.id>? ORDER BY q.id LIMIT 201`,
    fields: [
      "cursor",
      "username",
      "status",
      "scheduled_at",
      "body",
      "comments_json",
      "result_ids_json",
      "updated_at",
    ],
  },
] as const;

type SheetMeta = {
  sheets?: Array<{
    properties: {
      sheetId: number;
      gridProperties: { rowCount: number; columnCount: number };
    };
  }>;
};
type Connection = {
  refresh_enc: string;
  spreadsheet_id: string | null;
  updated_at: string;
};

export async function enqueueSheetSyncs(ctx: JobContext): Promise<void> {
  if (!googleConfigured(ctx.env)) return;
  const now = ctx.now.toISOString();
  // At most 20 new synchronizations/minute, with global API quotas additionally enforced at fetch.
  await ctx.sys.run(
    `INSERT INTO jobs(id,type,state_json,status,priority,next_run_at,attempts,created_at,updated_at)
    SELECT lower(hex(randomblob(16))),'sheets_sync',json_object('userId',g.user_id),'pending',8,?,0,?,?
    FROM google_connections g JOIN users u ON u.id=g.user_id JOIN licenses l ON l.id=u.license_id
    WHERE g.status='connected' AND l.status='active' AND g.next_sync_at<=?
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type='sheets_sync' AND j.status IN ('pending','running') AND json_extract(j.state_json,'$.userId')=g.user_id)
    ORDER BY g.next_sync_at,g.user_id LIMIT 20`,
    now,
    now,
    now,
    now,
  );
}

async function provision(
  ctx: JobContext,
  userId: string,
  access: string,
  lease: string,
): Promise<string> {
  // Search by app-owned metadata first: retrying a lost create response must not blindly create another file.
  const q = new URLSearchParams({
    q: `trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet' and appProperties has { key='tapOwner' and value='${userId}' }`,
    fields: "files(id)",
    pageSize: "10",
  });
  const found = await googleRequest<{ files?: Array<{ id: string }> }>(
    ctx.db,
    ctx.budget,
    `https://www.googleapis.com/drive/v3/files?${q}`,
    { method: "GET", headers: googleHeaders(access) },
  );
  let id = found.files?.[0]?.id;
  if (!id) {
    const file = await googleRequest<{ id: string }>(
      ctx.db,
      ctx.budget,
      "https://www.googleapis.com/drive/v3/files?fields=id",
      {
        method: "POST",
        headers: googleHeaders(access),
        body: JSON.stringify({
          name: "Threads Autopilot 管理表",
          mimeType: "application/vnd.google-apps.spreadsheet",
          appProperties: { tapOwner: userId },
        }),
      },
    );
    id = file.id;
  }
  if (!id || !/^[\w-]+$/.test(id)) throw new GoogleError("temporary");
  const meta = await googleRequest<SheetMeta>(
    ctx.db,
    ctx.budget,
    `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`,
    { method: "GET", headers: googleHeaders(access) },
  );
  const existing = new Set(meta.sheets?.map((s) => s.properties.sheetId));
  const requests: unknown[] = [];
  for (let sheetId = 0; sheetId < 6; sheetId++) {
    const title = sheetId === 5 ? "自由メモ" : SHEET_TABS[sheetId]!.title;
    if (existing.has(sheetId)) {
      requests.push({
        updateSheetProperties: {
          properties: { sheetId, title },
          fields: "title",
        },
      });
    } else
      requests.push({
        addSheet: {
          properties: {
            sheetId,
            title,
            gridProperties: { rowCount: 1000, columnCount: 20 },
          },
        },
      });
  }
  if (!existing.has(5))
    requests.push({
      updateCells: {
        start: { sheetId: 5, rowIndex: 0, columnIndex: 0 },
        rows: [
          {
            values: [
              {
                userEnteredValue: {
                  stringValue:
                    "自由に編集できます。他の5タブはアプリのデータで定期更新されます。原稿の編集・予約はアプリから行ってください。",
                },
              },
            ],
          },
        ],
        fields: "userEnteredValue",
      },
    });
  await googleRequest(
    ctx.db,
    ctx.budget,
    `https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`,
    {
      method: "POST",
      headers: googleHeaders(access),
      body: JSON.stringify({ requests }),
    },
  );
  const saved = await ctx.db.run(
    "UPDATE google_connections SET spreadsheet_id=? WHERE user_id=? AND lease_id=?",
    id,
    userId,
    lease,
  );
  if (!saved.changes) throw new GoogleError("temporary");
  return id;
}

function cell(value: unknown) {
  // stringValue prevents spreadsheet formula execution even when a post starts with '='.
  return {
    userEnteredValue:
      typeof value === "number"
        ? { numberValue: value }
        : { stringValue: value == null ? "" : String(value) },
  };
}
export async function sheetsSyncJob(
  ctx: JobContext,
  job: RunningJob,
): Promise<void> {
  const userId = typeof job.state.userId === "string" ? job.state.userId : null;
  if (!userId || !googleConfigured(ctx.env)) return;
  const lease = crypto.randomUUID(),
    now = ctx.now.toISOString();
  const row = await ctx.db.first<Connection>(
    `UPDATE google_connections SET lease_id=?,lease_until=? WHERE user_id=? AND status='connected'
    AND (lease_until IS NULL OR lease_until<?) AND EXISTS (SELECT 1 FROM users u JOIN licenses l ON l.id=u.license_id WHERE u.id=? AND l.status='active')
    RETURNING refresh_enc,spreadsheet_id,updated_at`,
    lease,
    new Date(ctx.now.getTime() + 120_000).toISOString(),
    userId,
    now,
    userId,
  );
  if (!row) return;
  try {
    const access = await googleAccess(
      ctx.env,
      ctx.db,
      ctx.budget,
      row.refresh_enc,
    );
    const id =
      row.spreadsheet_id ?? (await provision(ctx, userId, access, lease));
    if (job.state.spreadsheetId !== id) {
      job.state = { userId, spreadsheetId: id, tab: 0, cursor: "", offset: 1 };
    }
    const meta = await googleRequest<SheetMeta>(
      ctx.db,
      ctx.budget,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=sheets.properties`,
      { method: "GET", headers: googleHeaders(access) },
    );
    // Bounded pages, resumable state. The final timestamp advances only after all tabs finish.
    for (let pages = 0; pages < 5; pages++) {
      ctx.budget.timeMs.check();
      const tabIndex = Number(job.state.tab ?? 0),
        tab = SHEET_TABS[tabIndex];
      if (!tab) {
        const jitter =
          parseInt(userId.replace(/-/g, "").slice(0, 4), 16) % 300_000;
        await ctx.db.run(
          "UPDATE google_connections SET last_sync_at=?,last_error=NULL,next_sync_at=? WHERE user_id=? AND lease_id=?",
          now,
          new Date(ctx.now.getTime() + 3600_000 + jitter).toISOString(),
          userId,
          lease,
        );
        return;
      }
      const sheet = meta.sheets?.find(
        (s) => s.properties.sheetId === tabIndex,
      )?.properties;
      if (!sheet) throw new GoogleError("missing");
      const offset = Number(job.state.offset ?? 1);
      const all = await ctx.db.all<Record<string, unknown>>(
        tab.sql,
        userId,
        String(job.state.cursor ?? ""),
      );
      // Bound payload as well as row count (reference text can be 50,000 characters).
      const rows: Record<string, unknown>[] = [];
      let bytes = 0;
      for (const record of all.slice(0, 200)) {
        const size = new TextEncoder().encode(JSON.stringify(record)).length;
        if (rows.length && bytes + size > 500_000) break;
        rows.push(record);
        bytes += size;
      }
      const more = all.length > rows.length;
      const end = offset + rows.length;
      const rowCount = Math.max(sheet.gridProperties.rowCount, end + 1);
      const requests: unknown[] = [];
      if (
        rowCount > sheet.gridProperties.rowCount ||
        sheet.gridProperties.columnCount < tab.headers.length
      )
        requests.push({
          updateSheetProperties: {
            properties: {
              sheetId: tabIndex,
              gridProperties: {
                rowCount,
                columnCount: Math.max(
                  sheet.gridProperties.columnCount,
                  tab.headers.length,
                ),
              },
            },
            fields: "gridProperties.rowCount,gridProperties.columnCount",
          },
        });
      if (offset === 1)
        requests.push({
          updateCells: {
            start: { sheetId: tabIndex, rowIndex: 0, columnIndex: 0 },
            rows: [{ values: tab.headers.map(cell) }],
            fields: "userEnteredValue",
          },
        });
      if (rows.length)
        requests.push({
          updateCells: {
            start: { sheetId: tabIndex, rowIndex: offset, columnIndex: 0 },
            rows: rows.map((record) => ({
              values: tab.fields.map((field) => cell(record[field])),
            })),
            fields: "userEnteredValue",
          },
        });
      if (!more && end < rowCount)
        requests.push({
          updateCells: {
            range: {
              sheetId: tabIndex,
              startRowIndex: end,
              endRowIndex: rowCount,
              startColumnIndex: 0,
              endColumnIndex: tab.headers.length,
            },
            fields: "userEnteredValue",
          },
        });
      // Recheck disconnect/reconnect before any external write.
      if (
        !(await ctx.db.first(
          "SELECT user_id FROM google_connections WHERE user_id=? AND lease_id=?",
          userId,
          lease,
        ))
      )
        return;
      await googleRequest(
        ctx.db,
        ctx.budget,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}:batchUpdate`,
        {
          method: "POST",
          headers: googleHeaders(access),
          body: JSON.stringify({ requests }),
        },
      );
      job.state.tab = more ? tabIndex : tabIndex + 1;
      job.state.cursor = more ? String(rows.at(-1)!.cursor) : "";
      job.state.offset = more ? end : 1;
    }
    // Let another invocation continue instead of keeping one user in the worker indefinitely.
    if (Number(job.state.tab) < SHEET_TABS.length)
      throw new BudgetExceeded(
        "timeMs",
        ctx.budget.timeMs.limit + 1,
        ctx.budget.timeMs.limit,
      );
    await ctx.db.run(
      "UPDATE google_connections SET last_sync_at=?,last_error=NULL,next_sync_at=? WHERE user_id=? AND lease_id=?",
      now,
      new Date(ctx.now.getTime() + 3600_000).toISOString(),
      userId,
      lease,
    );
  } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    const problem = e instanceof GoogleError ? e : new GoogleError("temporary");
    await ctx.db.run(
      "UPDATE google_connections SET status=?,last_error=?,next_sync_at=? WHERE user_id=? AND lease_id=?",
      problem.kind === "reauth" || problem.kind === "missing"
        ? "needs_attention"
        : "connected",
      problem.message,
      new Date(
        ctx.now.getTime() + (problem.kind === "rate" ? 60_000 : 300_000),
      ).toISOString(),
      userId,
      lease,
    );
  } finally {
    await ctx.db.run(
      "UPDATE google_connections SET lease_id=NULL,lease_until=NULL WHERE user_id=? AND lease_id=?",
      userId,
      lease,
    );
  }
}

/**
 * CSV 書き出し（SPEC §7.8 `GET /export/:accountId?format=csv`）。
 *
 * 投稿と数字を1枚の CSV にする。買い手が自分のデータを持ち出せる経路であり、
 * 退会（`DELETE /users/me`）の前に控えを取るための出口でもある。
 *
 * - `format` は `csv` のみ（既定 `csv`）。パスに拡張子を食い込ませない（SPEC §7.8）
 * - **UTF-8 BOM 付き**。付けないと Excel（日本語 Windows）が Shift_JIS と誤認して
 *   全部文字化けする。買い手が最初に開くのは十中八九 Excel なので、ここは BOM を優先する
 * - 改行コードは CRLF（RFC 4180）。セルは常に `"` で囲み、中の `"` は `""` にする
 * - 先頭が `= + - @` のセルは `'` を1つ足してから囲む（表計算ソフトの数式実行を防ぐ）
 * - 日時はアカウントの timezone で `YYYY-MM-DD HH:mm`（SPEC §2.4）
 */
import { Hono } from "hono";
import { fail, type AppEnv } from "../app";
import { loadOwnedAccount } from "../lib/accounts";
import { audit } from "../lib/audit";

/** 1回の書き出しで出す上限。D1 と CPU の両方を守る（超えたぶんは古い順に落ちる）。 */
export const EXPORT_MAX_ROWS = 5000;

export const CSV_HEADERS = [
  "投稿ID",
  "種別",
  "投稿日時",
  "本文",
  "リンク",
  "表示回数",
  "いいね",
  "返信",
  "リポスト",
  "引用",
  "シェア",
  "推定クリック",
  "型",
  "長さ",
  "枠",
  "出所",
  "48h表示回数",
  "48hいいね",
  "7d表示回数",
  "30d表示回数",
  "パーマリンク",
] as const;

/**
 * 1セルを CSV に直す。常に引用符で囲む（改行と読点を含む本文がそのまま入るため）。
 * `= + - @` 始まりは `'` を足す — Excel / Google スプレッドシートが式として実行するのを防ぐ。
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/** `YYYY-MM-DD HH:mm`（アカウントの timezone）。 */
export function formatCsvDate(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

type ExportRow = {
  id: string;
  is_reply: number;
  text: string;
  permalink: string | null;
  posted_at: string;
  link_attachment_url: string | null;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  shares: number;
  clicks: number;
  tags_json: string;
  source: string;
};

type HistoryRow = {
  post_id: string;
  checkpoint: string;
  views: number | null;
  likes: number | null;
};

function tag(tagsJson: string, key: string): string {
  try {
    const t = JSON.parse(tagsJson) as Record<string, unknown>;
    const v = t[key];
    return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  } catch {
    return "";
  }
}

/** `weekday` + `21` → `平日 21時台`（画面と同じ表記。SPEC §12.3）。 */
function slotCell(tagsJson: string): string {
  const slot = tag(tagsJson, "slot");
  if (slot === "") return "";
  const daytype = tag(tagsJson, "daytype");
  const prefix = daytype === "weekend" ? "土日" : daytype === "weekday" ? "平日" : "";
  return prefix === "" ? `${slot}時台` : `${prefix} ${slot}時台`;
}

/** 本文とタグから CSV の1行を作る。テストから直接呼ぶ。 */
export function toCsvRow(
  row: ExportRow,
  tz: string,
  history: { h48: HistoryRow | undefined; h7: HistoryRow | undefined; h30: HistoryRow | undefined },
): string {
  return csvRow([
    row.id,
    row.is_reply ? "コメント" : "本文",
    formatCsvDate(row.posted_at, tz),
    row.text,
    row.link_attachment_url ?? "",
    row.views,
    row.likes,
    row.replies,
    row.reposts,
    row.quotes,
    row.shares,
    // 按分後のクリックは小数になる（SPEC §8.5）。小数第1位までで十分
    Math.round(row.clicks * 10) / 10,
    tag(row.tags_json, "hook"),
    tag(row.tags_json, "length"),
    slotCell(row.tags_json),
    row.source,
    history.h48?.views ?? "",
    history.h48?.likes ?? "",
    history.h7?.views ?? "",
    history.h30?.views ?? "",
    row.permalink ?? "",
  ]);
}

export function exportRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/:accountId", async (c) => {
    const format = (c.req.query("format") ?? "csv").toLowerCase();
    if (format !== "csv") {
      return fail("BAD_REQUEST", "いまは CSV だけ書き出せます", 400);
    }

    const db = c.get("db");
    const userId = c.get("userId")!;
    const account = await loadOwnedAccount(db, c.req.param("accountId"), userId);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const posts = await db.all<ExportRow>(
      `SELECT id, is_reply, text, permalink, posted_at, link_attachment_url,
              views, likes, replies, reposts, quotes, shares, clicks, tags_json, source
         FROM posts
        WHERE account_id=? AND deleted=0
        ORDER BY posted_at DESC
        LIMIT ?`,
      account.id,
      EXPORT_MAX_ROWS,
    );

    // 履歴は1クエリでまとめて引き、投稿IDで引けるようにしておく（1投稿あたり最大3行。SPEC §8.4）
    const history = await db.all<HistoryRow>(
      "SELECT post_id, checkpoint, views, likes FROM post_metrics_history WHERE account_id=?",
      account.id,
    );
    const byPost = new Map<string, HistoryRow[]>();
    for (const h of history) {
      const list = byPost.get(h.post_id);
      if (list) list.push(h);
      else byPost.set(h.post_id, [h]);
    }

    const lines: string[] = [csvRow([...CSV_HEADERS])];
    for (const p of posts) {
      const hs = byPost.get(p.id) ?? [];
      lines.push(
        toCsvRow(p, account.timezone, {
          h48: hs.find((h) => h.checkpoint === "48h"),
          h7: hs.find((h) => h.checkpoint === "7d"),
          h30: hs.find((h) => h.checkpoint === "30d"),
        }),
      );
    }

    await audit(db, userId, "export", { accountId: account.id, rows: posts.length });

    // BOM 付き UTF-8（Excel 対策）＋ CRLF（RFC 4180）
    const body = `﻿${lines.join("\r\n")}\r\n`;
    const filename = `threads-${account.username}-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        // ASCII 版と RFC 5987 版の両方を出す（username に日本語が入ることがある）
        "Content-Disposition": `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store, private",
      },
    });
  });

  return r;
}

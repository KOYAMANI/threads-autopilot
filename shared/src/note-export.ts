/**
 * note の原稿を、note.com のエディタに貼る形にする（SPEC §7.10）。
 *
 * - 章は `##`、本文中の `## 節` は `###` に下げる（記事タイトルが `#` のため）
 * - 有料ラインは「（ここから有料）」の段落。note 側の有料設定は貼ったあとに利用者が行う
 * - `【 】` は自分で埋める箇所。そのまま残す
 */
import type { NoteDetail, NoteSection } from "./types";

export type NoteExportRange = { kind: "all" } | { kind: "chapter"; sectionId: string };

export const PAYWALL_MARK = "（ここから有料）";

function pick(note: NoteDetail, range: NoteExportRange): NoteSection[] {
  const sections = [...note.sections].sort((a, b) => a.ord - b.ord);
  if (range.kind === "chapter") return sections.filter((s) => s.id === range.sectionId);
  return sections;
}

/** 本文を段落（空行区切り）に分ける。`## ` で始まる段落は節の見出し。 */
export function splitParagraphs(body: string): string[] {
  return body
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

export function noteToMarkdown(note: NoteDetail, range: NoteExportRange = { kind: "all" }): string {
  const parts: string[] = [];
  if (range.kind === "all" && note.title.trim() !== "") parts.push(`# ${note.title.trim()}`);
  for (const s of pick(note, range)) {
    if (range.kind === "all" && note.paywallAfter !== null && s.ord === note.paywallAfter + 1) parts.push(PAYWALL_MARK);
    parts.push(`## ${s.heading}`);
    for (const p of splitParagraphs(s.body)) parts.push(p.startsWith("## ") ? `### ${p.slice(3).trim()}` : p);
  }
  return parts.join("\n\n") + "\n";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** 段落1つを HTML に。箇条書き（`- ` / `1. `）と太字（`**`）だけ扱う。 */
function paragraphHtml(p: string): string {
  const lines = p.split("\n");
  const bullet = lines.every((l) => /^[-・] /.test(l));
  const numbered = lines.every((l) => /^\d+[.．] /.test(l));
  const inline = (t: string) => escapeHtml(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  if (bullet) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^[-・] /, ""))}</li>`).join("")}</ul>`;
  if (numbered) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\d+[.．] /, ""))}</li>`).join("")}</ol>`;
  return `<p>${lines.map(inline).join("<br>")}</p>`;
}

export function noteToHtml(note: NoteDetail, range: NoteExportRange = { kind: "all" }): string {
  const parts: string[] = [];
  if (range.kind === "all" && note.title.trim() !== "") parts.push(`<h1>${escapeHtml(note.title.trim())}</h1>`);
  for (const s of pick(note, range)) {
    if (range.kind === "all" && note.paywallAfter !== null && s.ord === note.paywallAfter + 1) parts.push(`<p>${PAYWALL_MARK}</p>`);
    parts.push(`<h2>${escapeHtml(s.heading)}</h2>`);
    for (const p of splitParagraphs(s.body)) parts.push(p.startsWith("## ") ? `<h3>${escapeHtml(p.slice(3).trim())}</h3>` : paragraphHtml(p));
  }
  return parts.join("\n") + "\n";
}

/** 自分で埋める箇所（`【 】`）を章ごとに拾う。 */
export function notePlaceholders(note: NoteDetail): Array<{ sectionId: string; ord: number; text: string }> {
  const out: Array<{ sectionId: string; ord: number; text: string }> = [];
  for (const s of [...note.sections].sort((a, b) => a.ord - b.ord)) {
    if (s.status !== "done") continue;
    for (const m of s.body.matchAll(/【([^】]+)】/g)) out.push({ sectionId: s.id, ord: s.ord, text: m[1]! });
  }
  return out;
}

/** 文字数（改行・空白を除く）。目安の表示に使う。 */
export function noteCharCount(body: string): number {
  return [...body.replace(/\s+/g, "")].length;
}

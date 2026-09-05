/**
 * 投稿前の検査（SPEC §6.3 / §9.6）。web と worker の両方から呼ぶ。
 * - 本文 500 文字
 * - 1投稿にリンク5本まで
 * - NGワード
 * - link_placement='comment' のとき本文に URL を置かない
 */
import { extractUrls } from "./url";

export const MAX_BODY_LENGTH = 500;
export const MAX_LINKS_PER_POST = 5;

export type LinkPlacement = "comment" | "body" | "none";

export type ValidateOptions = {
  /** 既定 'comment'。SPEC §9.6 */
  linkPlacement?: LinkPlacement;
  /** 改行・読点区切りの NG ワード列（autopilot.ng_words の生値でよい） */
  ngWords?: string | string[];
  /** ツリーのコメント本文。本数・長さは本文と同じ基準で見る */
  comments?: string[];
};

export type ValidationIssue = { code: string; message: string; field: string };
export type ValidationResult = { ok: boolean; issues: ValidationIssue[] };

/**
 * 本文長。API 資料は「絵文字は UTF-8 バイト数で数える」としており、コードポイント数と
 * 食い違う。smoke.ts（SPEC §14-4）で実測して確定するまでは厳しい方を採用する。
 */
export function bodyLength(text: string): number {
  const codePoints = [...(text ?? "")].length;
  const utf8Bytes = new TextEncoder().encode(text ?? "").length;
  return Math.max(codePoints, utf8Bytes);
}

export function parseNgWords(ngWords: string | string[] | undefined): string[] {
  if (!ngWords) return [];
  const list = Array.isArray(ngWords) ? ngWords : ngWords.split(/[\n,、]/);
  return list.map((w) => w.trim()).filter((w) => w !== "");
}

export function validatePost(body: string, options: ValidateOptions = {}): ValidationResult {
  const { linkPlacement = "comment", ngWords, comments = [] } = options;
  const issues: ValidationIssue[] = [];
  const text = body ?? "";

  if (text.trim() === "") {
    issues.push({ code: "BODY_EMPTY", message: "本文が空です", field: "body" });
  }

  const len = bodyLength(text);
  if (len > MAX_BODY_LENGTH) {
    issues.push({
      code: "BODY_TOO_LONG",
      message: `本文は${MAX_BODY_LENGTH}文字までです（いまは${len}文字）`,
      field: "body",
    });
  }
  comments.forEach((c, i) => {
    const cl = bodyLength(c ?? "");
    if (cl > MAX_BODY_LENGTH) {
      issues.push({
        code: "COMMENT_TOO_LONG",
        message: `コメント${i + 1}は${MAX_BODY_LENGTH}文字までです（いまは${cl}文字）`,
        field: `comments.${i}`,
      });
    }
  });

  const bodyUrls = extractUrls(text);
  if (bodyUrls.length > MAX_LINKS_PER_POST) {
    issues.push({
      code: "LINK_LIMIT",
      message: `1投稿に入れられるリンクは${MAX_LINKS_PER_POST}つまでです（いまは${bodyUrls.length}つ）`,
      field: "body",
    });
  }
  comments.forEach((c, i) => {
    const n = extractUrls(c ?? "").length;
    if (n > MAX_LINKS_PER_POST) {
      issues.push({
        code: "LINK_LIMIT",
        message: `1投稿に入れられるリンクは${MAX_LINKS_PER_POST}つまでです（コメント${i + 1}は${n}つ）`,
        field: `comments.${i}`,
      });
    }
  });

  if (linkPlacement !== "body" && bodyUrls.length > 0) {
    issues.push({
      code: "LINK_IN_BODY",
      message:
        linkPlacement === "comment"
          ? "リンクはコメントに置く設定です。本文にURLを書かないでください"
          : "リンクを使わない設定です。本文にURLを書かないでください",
      field: "body",
    });
  }

  const ng = parseNgWords(ngWords);
  const haystacks: Array<[string, string]> = [["body", text], ...comments.map((c, i) => ["comments." + i, c ?? ""] as [string, string])];
  for (const word of ng) {
    for (const [field, hay] of haystacks) {
      if (hay.includes(word)) {
        issues.push({
          code: "NG_WORD",
          message: `使わない言葉に指定した「${word}」が入っています`,
          field,
        });
        break;
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

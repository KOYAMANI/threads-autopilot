/**
 * Gemini が誤って改行付きの本文全体を「1行目候補」として返しても、
 * 投稿本文の最初の非空行だけを安全に差し替える。
 */
export function replaceFirstContentLine(body: string, suggestion: string): string {
  const replacement = suggestion
    .replace(/\r/g, "")
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();
  if (!replacement) return body;

  const lines = body.replace(/\r/g, "").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first < 0) return body;
  lines[first] = replacement;
  return lines.join("\n");
}

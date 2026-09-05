/**
 * 重複チェック用の類似度（SPEC §8.3）。
 *   normalize(t): URL を除去 → 空白・改行・全角空白を除去 → 小文字化
 *   grams(t):     normalize(t) の連続3文字の集合（長さ3未満なら1文字ずつの集合）
 *   similarity(a,b) = |grams(a) ∩ grams(b)| / |grams(a) ∪ grams(b)|  （Jaccard 係数）
 */

/** SPEC §8.3 の normalize。 */
export function normalizeForSimilarity(text: string): string {
  return (text ?? "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\s　]+/g, "")
    .toLowerCase();
}

/** 正規化した文字列の連続3文字の集合。長さ3未満なら1文字ずつ。 */
export function grams(text: string): Set<string> {
  const chars = [...normalizeForSimilarity(text)];
  const out = new Set<string>();
  if (chars.length === 0) return out;
  if (chars.length < 3) {
    for (const c of chars) out.add(c);
    return out;
  }
  for (let i = 0; i + 3 <= chars.length; i++) {
    out.add(chars.slice(i, i + 3).join(""));
  }
  return out;
}

/** 3-gram Jaccard 係数（0..1）。両方空なら 0 を返す。 */
export function similarity(a: string, b: string): number {
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 && gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  const union = ga.size + gb.size - inter;
  if (union === 0) return 0;
  return inter / union;
}

/** SPEC §8.3 の重複判定しきい値。 */
export const DUPLICATE_THRESHOLD = 0.8;

/**
 * URL の正規化と抽出（SPEC §8.5）。
 * クリックの突合（threads_insights の link_url）と、投稿本文からの抽出の両方で共用する。
 */

/** normalizeUrl で落とす追跡パラメータ（SPEC §8.5 手順5）。 */
const DROP_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "igshid",
  "ref",
  "ref_src",
  "si",
]);

/**
 * SPEC §8.5 の7手順をそのまま実装する。
 * パースできない入力は、小文字化してそのまま返す（突合キーとしては使える）。
 */
export function normalizeUrl(input: string): string {
  const trimmed = (input ?? "").trim();
  if (trimmed === "") return "";
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }

  // 2. scheme と host を小文字化。host 末尾の "." を除去
  const protocol = u.protocol.toLowerCase();
  let host = u.hostname.toLowerCase().replace(/\.$/, "");

  // 3. 既定ポートを除去
  let port = u.port;
  if ((protocol === "http:" && port === "80") || (protocol === "https:" && port === "443")) {
    port = "";
  }

  // 5. 追跡パラメータを落とし、残りをキー昇順に並べ替える
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) {
    if (DROP_PARAMS.has(k.toLowerCase())) continue;
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const search = pairs.length
    ? "?" + pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";

  // 6. パス末尾の "/" を除去（"/" だけなら空にする）
  let path = u.pathname;
  if (path === "/") path = "";
  else path = path.replace(/\/+$/, "");

  // 7. 組み立て直す（4. フラグメントは付けない）
  const auth = u.username ? `${u.username}${u.password ? ":" + u.password : ""}@` : "";
  host = port ? `${host}:${port}` : host;
  return `${protocol}//${auth}${host}${path}${search}`;
}

/** 本文末尾に付きがちな記号（SPEC §8.5 の extractUrls）。 */
const TRAILING = /[。、，．,.!?！？)）」』】>＞〉》\]]+$/;

/**
 * 本文から URL を拾う。末尾の句読点・閉じ括弧を剥がし、重複は除く。
 * 正規化はしない（呼び出し側が normalizeUrl を通す）。
 */
export function extractUrls(text: string): string[] {
  const found = (text ?? "").match(/https?:\/\/[^\s]+/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    let url = raw;
    let prev = "";
    while (url !== prev) {
      prev = url;
      url = url.replace(TRAILING, "");
    }
    if (url === "" || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

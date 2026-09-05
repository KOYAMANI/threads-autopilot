/**
 * 実トークンでの Threads API 疎通確認（SPEC §14）。**M1 では実行しない**。
 * オーナーから実トークンが届いた時点で、オーナー環境で1回だけ流す。
 *
 * 確認すること（SPEC §14）:
 *   1. /me が返る
 *   2. auto_publish_text=true のテキスト投稿が1ステップで公開される
 *   3. auto_publish_text=true と reply_to_id の併用でツリー2投稿目が作れるか（H5）
 *      → 作れなければ wrangler.toml の REPLY_TWO_STEP を 1 にする（SPEC §8.3）
 *   4. 絵文字を含む本文の文字数上限が「コードポイント数」か「UTF-8バイト数」か（SPEC §6.3）
 *   5. threads_insights?metric=clicks の link_url が投稿本文のURLとどこまで一致するか（SPEC §8.5）
 *   6. 実行後は作った投稿を削除する（DELETE /{media-id}）
 *
 * 使い方:
 *   THREADS_TOKEN=... npm run smoke              # 3〜5 の確認（投稿を作って消す）
 *   THREADS_TOKEN=... npm run smoke -- --dry     # 読み取りだけ（1 と 5 のみ）
 *   THREADS_TOKEN=... npm run smoke -- --keep    # 後始末（削除）をしない
 */
import { normalizeUrl } from "../shared/src/url";

const BASE = "https://graph.threads.net/v1.0";

type Json = Record<string, any>;

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function usage(): never {
  console.log(
    [
      "smoke.ts — 実トークンでの Threads API 疎通確認（SPEC §14）",
      "",
      "  環境変数 THREADS_TOKEN に、Meta アプリで発行した実トークンを入れて実行します。",
      "  実行すると Threads に投稿が作られ、最後に削除されます（--keep で残せます）。",
      "",
      "使い方:",
      "  THREADS_TOKEN=... npm run smoke",
      "  THREADS_TOKEN=... npm run smoke -- --dry    # 読み取りのみ（投稿しない）",
      "  THREADS_TOKEN=... npm run smoke -- --keep   # 後始末をしない",
    ].join("\n"),
  );
  process.exit(1);
}

const token = process.env.THREADS_TOKEN;
if (!token) usage();

const dry = process.argv.includes("--dry");
const keep = process.argv.includes("--keep");
const created: string[] = [];

async function call(method: "GET" | "POST" | "DELETE", path: string, params: Json = {}): Promise<Json> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
  q.set("access_token", token!);
  const res = await fetch(`${BASE}${path}?${q}`, { method });
  const text = await res.text();
  let json: Json;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    fail(`JSONではない応答: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const e = json.error ?? {};
    throw new Error(`#${e.code ?? res.status} ${e.message ?? text.slice(0, 200)}`);
  }
  return json;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const results: Array<[string, string]> = [];

  // 1. /me
  const me = await call("GET", "/me", { fields: "id,username,name" });
  console.log(`1. /me OK  id=${me.id} username=${me.username}`);
  results.push(["1. /me", "OK"]);

  // 5. clicks の link_url（読み取りのみ。先に取っておく）
  try {
    const until = Math.floor(Date.now() / 1000);
    const since = until - 30 * 86400;
    const clicks = await call("GET", "/me/threads_insights", { metric: "clicks", since, until });
    const values: Array<{ link_url: string; value: number }> =
      clicks.data?.[0]?.link_total_values ?? [];
    console.log(`5. clicks: ${values.length} 件の link_url`);
    for (const v of values.slice(0, 10)) {
      console.log(`   ${v.value.toString().padStart(6)}  ${v.link_url}`);
      console.log(`           → normalizeUrl: ${normalizeUrl(v.link_url)}`);
    }
    results.push(["5. clicks link_url", `${values.length}件（上の一覧を §8.5 の調整に使う）`]);
  } catch (e) {
    console.log(`5. clicks: 取得できませんでした（${String(e)}）`);
    results.push(["5. clicks link_url", `NG: ${String(e)}`]);
  }

  if (dry) {
    console.log("\n--dry のため、投稿を伴う 2〜4 は実行しませんでした。");
    summary(results);
    return;
  }

  // 2. auto_publish_text で1ステップ公開
  const stamp = new Date().toISOString();
  const root = await call("POST", "/me/threads", {
    media_type: "TEXT",
    text: `[smoke] 疎通確認の投稿です ${stamp}`,
    auto_publish_text: "true",
  });
  if (!root.id) fail("2. auto_publish_text の応答に id がありません");
  created.push(root.id);
  console.log(`2. auto_publish_text の1ステップ公開 OK  id=${root.id}`);
  results.push(["2. auto_publish_text 1ステップ", "OK"]);

  await sleep(3000);

  // 3. H5: auto_publish_text × reply_to_id の併用
  let replyOk = false;
  try {
    const reply = await call("POST", "/me/threads", {
      media_type: "TEXT",
      text: `[smoke] ツリー2投稿目 ${stamp}`,
      reply_to_id: root.id,
      auto_publish_text: "true",
    });
    if (reply.id) {
      created.push(reply.id);
      replyOk = true;
    }
  } catch (e) {
    console.log(`3. 併用が拒否されました: ${String(e)}`);
  }
  console.log(
    replyOk
      ? "3. H5 OK: 1ステップ方式が使えます → wrangler.toml の REPLY_TWO_STEP=0 のままでよい"
      : "3. H5 NG: 1ステップ方式が使えません → wrangler.toml の REPLY_TWO_STEP=1 に変更する（SPEC §8.3）",
  );
  results.push(["3. H5 auto_publish_text × reply_to_id", replyOk ? "OK（REPLY_TWO_STEP=0）" : "NG（REPLY_TWO_STEP=1 にする）"]);

  // 4. 文字数の数え方（絵文字）
  // "🙂" はコードポイント1・UTF-8で4バイト。498文字ぶんの ASCII + 絵文字1つで
  // コードポイント499 / バイト502。バイト換算なら弾かれ、コードポイント換算なら通る。
  const probe = "a".repeat(498) + "🙂";
  let byteBased: boolean | null = null;
  try {
    const res = await call("POST", "/me/threads", {
      media_type: "TEXT",
      text: probe,
      auto_publish_text: "true",
    });
    if (res.id) created.push(res.id);
    byteBased = false;
  } catch (e) {
    console.log(`4. 拒否されました: ${String(e)}`);
    byteBased = true;
  }
  console.log(
    byteBased
      ? "4. 文字数は UTF-8 バイト数で数えられています → validatePost はバイト基準（現状の実装どおり）"
      : "4. 文字数はコードポイント数で数えられています → validatePost をコードポイント基準に緩められる（SPEC §6.3）",
  );
  results.push(["4. 500文字の数え方", byteBased ? "UTF-8バイト数" : "コードポイント数"]);

  summary(results);
}

function summary(results: Array<[string, string]>): void {
  console.log("\n─── まとめ ───");
  for (const [name, value] of results) console.log(`  ${name}: ${value}`);
  console.log("\nこの結果を DECISIONS.md に1行ずつ追記すること（SPEC §0-4）。");
}

async function cleanup(): Promise<void> {
  if (keep || created.length === 0) return;
  console.log(`\n6. 後始末: ${created.length} 件の投稿を削除します`);
  for (const id of created.reverse()) {
    try {
      await call("DELETE", `/${id}`);
      console.log(`   削除 OK  ${id}`);
    } catch (e) {
      console.log(`   削除できませんでした ${id}: ${String(e)}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(`\n✗ 失敗: ${String(e)}`);
    process.exitCode = 1;
  })
  .finally(cleanup);

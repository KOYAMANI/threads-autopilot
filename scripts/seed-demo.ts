/**
 * デモ用ダミーデータの投入（SPEC §11 / §13 M1）。
 *
 * ここに直書きした固定データが**デモデータの正本**（DECISIONS 2026-09-06）。
 * `docs/prototype.jsx` は消失し再提供の見込みがないため、SPEC §11 が言う
 * 「M3 で prototype の makeAccount() 移植版へ差し替える」は行わない。
 * 乱数は使わない（何度実行しても同じ状態になる ＝ テストが値を前提にできる）。
 *
 * 使い方:
 *   npm run seed:demo                                  # ローカル D1
 *   npm run seed:demo -- --email demo@example.com      # ユーザーのメールを指定
 *   npm run seed:demo -- --remote                      # 本番 D1（原則使わない）
 *   npm run seed:demo -- --sql-only > /tmp/seed.sql    # SQL を出すだけ
 *
 * 事前に `npm run db:migrate` を1度流しておくこと。
 */
import { spawnSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTags, classifyHook } from "../shared/src/tags";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ── 固定値（乱数なし） ───────────────────────────── */

const DEMO = {
  userId: "11111111-1111-4111-8111-111111111111",
  licenseId: "22222222-2222-4222-8222-222222222222",
  licenseKey: "TAP-DEMO-DEMO-DEMO",
  accountId: "33333333-3333-4333-8333-333333333333",
  threadsUserId: "17800000000000001",
  username: "demo_yama",
  // パスワードは "password1234"。PBKDF2-SHA256 100,000回・salt 16バイト（0x00..0x0f 固定）。
  // 何度実行しても同じ値になるよう、生成済みの値を直書きする（デモ専用。本番の値ではない）。
  passHash: "fmmThy7w6gLovBzttVbAd8jUZZEY4P6uFRoNnvWWvrg=",
  passSalt: "AAECAwQFBgcICQoLDA0ODw==",
  tz: "Asia/Tokyo",
  // 起点。ここから相対で全ての日時を決める（実行日に依存させない）
  epoch: Date.UTC(2026, 8, 1, 12, 0, 0), // 2026-09-01T12:00:00Z = 21:00 JST
};

const BODIES = [
  "朝の30分だけで下書きを3本つくる手順を書きます。\nまずは机の上を片付けます。",
  "実は、伸びない投稿には共通点があります。\n1行目で誰に向けた話かを言っていません。",
  "副業を始めたい人へ。\n最初の1ヶ月は数字を見ないでください。",
  "これは危険なやり方です。\nフォロワーを買うと、表示回数だけが死にます。",
  "3つの型を回すだけで、ネタ切れは止まります。",
  "私は半年間、毎日21時に投稿を続けてきました。\n分かったことを書きます。",
  "投稿を出す時間、決めてますか。\n決めていないなら、まず21時に固定してください。",
  "1日1本でいい。\n30日で30本たまります。",
  "危険なのは、伸びた投稿を分析しないことです。\n伸びた理由が分からないと再現できません。",
  "実は、コメント欄の1本目がいちばん読まれています。",
  "投稿の型を7つ持つと、迷う時間がゼロになります。",
  "やめたほうがいいのは、毎回ちがう文体で書くことです。",
  "あなたが読まれない理由は、書く量ではありません。",
  "私がやってみて分かったのは、時間帯より1行目が効くということでした。",
  "5分で書ける投稿を、まず10本ためてください。",
];

const COMMENTS = [
  "続きはこちらにまとめました https://lin.ee/threadsdemo",
  "型シートを配っています https://example.com/sheet",
  "手順の全文はこちら https://lin.ee/threadsdemo",
  "作業テンプレはこちら https://example.com/sheet",
  "詳しい解説はこちら https://lin.ee/threadsdemo",
];

const LINKS = [
  { id: "44444444-4444-4444-8444-000000000001", url: "https://lin.ee/threadsdemo", label: "公式LINE", kind: "line" },
  { id: "44444444-4444-4444-8444-000000000002", url: "https://example.com/sheet", label: "型シート", kind: "other" },
];

const SOURCES = [
  {
    id: "55555555-5555-4555-8555-000000000001",
    type: "text",
    title: "デモ用の参考情報（テキスト）",
    content: "Threads の投稿は1行目で読者が決まる。前置きを書かない。1段落は3行以内にする。",
  },
  {
    id: "55555555-5555-4555-8555-000000000002",
    type: "url",
    title: "デモ用の参考情報（記事URL）",
    url: "https://example.com/article",
    content: "投稿の型を固定すると、書く時間が半分になる。型は7つあれば足りる。",
  },
];

/* ── 決定的な数値 ─────────────────────────────────── */

/** 添字から決まる固定値。乱数を使わない。 */
function viewsFor(i: number): number {
  return 1200 + ((i * 737) % 4300);
}
function likesFor(i: number): number {
  return 30 + ((i * 53) % 170);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
function dateOnly(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function q(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

/* ── デモアカウントのトークン ─────────────────────── */

/** .dev.vars から1つ読む（無ければ undefined）。 */
function devVar(name: string): string | undefined {
  const file = path.join(ROOT, ".dev.vars");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`).exec(line);
    if (m) return m[1]!.trim().replace(/^["']|["']$/g, "") || undefined;
  }
  return undefined;
}

/**
 * デモアカウントの token_enc。ENC_KEY があれば実際に暗号化して入れる（M2 のモック同期で使える）。
 * 再実行しても同じ SQL になるよう IV は固定にしている。
 * 平文は `THAAdemo_seed` というモック用の文字列で、実トークンではない（SPEC §11）。
 * ENC_KEY が無いときは復号できない目印を入れる（M2 で接続し直せばよい）。
 */
async function demoTokenEnc(): Promise<string> {
  const encKey = process.env.ENC_KEY ?? devVar("ENC_KEY");
  if (!encKey) return "SEED_NO_ENC_KEY";
  try {
    const raw = Buffer.from(encKey, "base64");
    if (raw.length !== 32) return "SEED_NO_ENC_KEY";
    const key = await webcrypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
    const iv = new Uint8Array(12); // 固定IV: このデモ用平文1つにしか使わない
    const ct = new Uint8Array(
      await webcrypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode("THAAdemo_seed"),
      ),
    );
    return Buffer.concat([Buffer.from(iv), Buffer.from(ct)]).toString("base64");
  } catch {
    return "SEED_NO_ENC_KEY";
  }
}

/* ── SQL の組み立て ───────────────────────────────── */

function buildSql(email: string, tokenEnc: string): string {
  const out: string[] = ["PRAGMA defer_foreign_keys = true;", "BEGIN TRANSACTION;"];
  const created = iso(DEMO.epoch - 60 * 86400_000);

  // 何度実行しても同じ状態になるよう、まず消す
  out.push(
    `DELETE FROM ap_log WHERE account_id=${q(DEMO.accountId)};`,
    `DELETE FROM learning WHERE account_id=${q(DEMO.accountId)};`,
    `DELETE FROM click_weeks_done WHERE account_id=${q(DEMO.accountId)};`,
    `DELETE FROM click_weeks WHERE account_id=${q(DEMO.accountId)};`,
    `DELETE FROM demographics WHERE account_id=${q(DEMO.accountId)};`,
    `DELETE FROM follower_snapshots WHERE account_id=${q(DEMO.accountId)};`,
    `DELETE FROM daily_views WHERE account_id=${q(DEMO.accountId)};`,
    `DELETE FROM post_metrics_history WHERE account_id=${q(DEMO.accountId)};`,
    `DELETE FROM posts WHERE account_id=${q(DEMO.accountId)};`,
    `DELETE FROM queue WHERE account_id=${q(DEMO.accountId)};`,
    `DELETE FROM links WHERE account_id=${q(DEMO.accountId)};`,
    `DELETE FROM autopilot WHERE account_id=${q(DEMO.accountId)};`,
    `DELETE FROM accounts WHERE id=${q(DEMO.accountId)};`,
    `DELETE FROM sources WHERE user_id=${q(DEMO.userId)};`,
    `DELETE FROM notifications WHERE user_id=${q(DEMO.userId)};`,
    `DELETE FROM ai_settings WHERE user_id=${q(DEMO.userId)};`,
    `DELETE FROM sessions WHERE user_id=${q(DEMO.userId)};`,
    `DELETE FROM password_resets WHERE user_id=${q(DEMO.userId)};`,
    `DELETE FROM users WHERE id=${q(DEMO.userId)};`,
    `DELETE FROM licenses WHERE id=${q(DEMO.licenseId)};`,
  );

  out.push(
    `INSERT INTO licenses (id, key, status, note, issued_at, activated_at, user_id, revoked_at)
     VALUES (${q(DEMO.licenseId)}, ${q(DEMO.licenseKey)}, 'active', 'seed-demo', ${q(created)}, ${q(created)}, ${q(DEMO.userId)}, NULL);`,
    `INSERT INTO users (id, email, pass_hash, pass_salt, license_id, created_at, last_login_at)
     VALUES (${q(DEMO.userId)}, ${q(email)}, ${q(DEMO.passHash)}, ${q(DEMO.passSalt)}, ${q(DEMO.licenseId)}, ${q(created)}, ${q(created)});`,
    `INSERT INTO notifications (user_id, email_enabled, push_enabled, digest_hour, updated_at)
     VALUES (${q(DEMO.userId)}, 1, 0, 8, ${q(created)});`,
    `INSERT INTO accounts (id, user_id, threads_user_id, username, name, avatar_url, color, token_enc,
        token_obtained_at, token_long_lived, token_last_refresh_at, status, timezone, settings_json,
        last_full_sync_at, created_at)
     VALUES (${q(DEMO.accountId)}, ${q(DEMO.userId)}, ${q(DEMO.threadsUserId)}, ${q(DEMO.username)},
        'デモアカウント', NULL, '#2748E8', ${q(tokenEnc)}, ${q(created)}, 1, NULL, 'ok',
        ${q(DEMO.tz)}, '{}', ${q(iso(DEMO.epoch))}, ${q(created)});`,
    `INSERT INTO autopilot (account_id, enabled, per_week, slot_mode, fixed_hour, approval_mode,
        approval_window_h, daily_limit, quiet_hours, ng_words, link_placement, hook_mode, fixed_hook,
        score_weights, consecutive_failures, updated_at)
     VALUES (${q(DEMO.accountId)}, 0, 7, 'auto', NULL, 'cancel', 4, 1, 1, '', 'comment', 'auto', NULL,
        'balanced', 0, ${q(created)});`,
  );

  for (const l of LINKS) {
    out.push(
      `INSERT INTO links (id, account_id, url, label, kind, enabled_for_ap, last_used_at, created_at)
       VALUES (${q(l.id)}, ${q(DEMO.accountId)}, ${q(l.url)}, ${q(l.label)}, ${q(l.kind)}, 1, NULL, ${q(created)});`,
    );
  }

  for (const s of SOURCES) {
    out.push(
      `INSERT INTO sources (id, user_id, type, title, url, content, char_count, enabled_for_ap,
          last_used_at, use_count, created_at)
       VALUES (${q(s.id)}, ${q(DEMO.userId)}, ${q(s.type)}, ${q(s.title)}, ${q(s.url ?? null)},
          ${q(s.content)}, ${s.content.length}, 1, NULL, 0, ${q(created)});`,
    );
  }

  // 投稿20本 = root 15 + children 5（SPEC §11）
  const postRows: string[] = [];
  const historyRows: string[] = [];
  let childIndex = 0;

  for (let i = 0; i < 15; i++) {
    const postedAt = DEMO.epoch - i * 2 * 86400_000;
    const id = `9000000000000${String(100 + i)}`;
    const body = BODIES[i]!;
    const views = viewsFor(i);
    const likes = likesFor(i);
    const tags = buildTags(body, new Date(postedAt), DEMO.tz, { link: "comment" });

    postRows.push(
      `(${q(DEMO.accountId)}, ${q(id)}, ${q(id)}, 0, ${q(body)},
        ${q(`https://www.threads.net/@${DEMO.username}/post/${id}`)}, 'TEXT_POST', NULL, NULL,
        ${q(iso(postedAt))}, ${views}, ${likes}, ${Math.round(likes * 0.12)}, ${Math.round(likes * 0.06)},
        ${Math.round(likes * 0.02)}, ${Math.round(likes * 0.04)}, ${i % 3 === 0 ? Math.round(views * 0.02) : 0},
        ${q(iso(DEMO.epoch))}, ${q(JSON.stringify({ ...tags, scored: true }))}, 'external', NULL, 0)`,
    );

    // 48h / 7d / 30d のチェックポイント（SPEC §8.4）。48h は全件、7d/30d は古い投稿だけ
    const ageDays = i * 2;
    const checkpoints: Array<[string, number, number]> = [["48h", 2, 0.55]];
    if (ageDays >= 7) checkpoints.push(["7d", 7, 0.8]);
    if (ageDays >= 30) checkpoints.push(["30d", 30, 0.95]);
    for (const [cp, days, ratio] of checkpoints) {
      historyRows.push(
        `(${q(DEMO.accountId)}, ${q(id)}, ${q(cp)}, ${q(iso(postedAt + days * 86400_000))},
          ${Math.round(views * ratio)}, ${Math.round(likes * ratio)}, ${Math.round(likes * 0.12 * ratio)},
          ${Math.round(likes * 0.06 * ratio)}, ${Math.round(likes * 0.02 * ratio)})`,
      );
    }

    // 3本に1本、コメント（children）を1本ぶら下げる → 合計5本
    if (i % 3 === 0 && childIndex < 5) {
      const cid = `9000000000000${String(200 + childIndex)}`;
      const ctext = COMMENTS[childIndex]!;
      const cviews = Math.round(views * 0.35);
      postRows.push(
        `(${q(DEMO.accountId)}, ${q(cid)}, ${q(id)}, 1, ${q(ctext)},
          ${q(`https://www.threads.net/@${DEMO.username}/post/${cid}`)}, 'TEXT_POST', NULL, NULL,
          ${q(iso(postedAt + 120_000))}, ${cviews}, ${Math.round(likes * 0.2)}, 0, 0, 0, 0, 0,
          ${q(iso(DEMO.epoch))}, ${q(JSON.stringify(buildTags(ctext, new Date(postedAt + 120_000), DEMO.tz)))},
          'external', NULL, 0)`,
      );
      childIndex++;
    }
  }

  out.push(
    `INSERT INTO posts (account_id, id, root_id, is_reply, text, permalink, media_type, media_url,
        link_attachment_url, posted_at, views, likes, replies, reposts, quotes, shares, clicks,
        metrics_fetched_at, tags_json, source, queue_id, deleted)
     VALUES\n${postRows.join(",\n")};`,
    `INSERT INTO post_metrics_history (account_id, post_id, checkpoint, at, views, likes, replies, reposts, quotes)
     VALUES\n${historyRows.join(",\n")};`,
  );

  // 日別表示 30日分 / フォロワースナップショット 30日分
  const dailyRows: string[] = [];
  const followerRows: string[] = [];
  for (let d = 29; d >= 0; d--) {
    const ms = DEMO.epoch - d * 86400_000;
    dailyRows.push(`(${q(DEMO.accountId)}, ${q(dateOnly(ms))}, ${3000 + ((29 - d) * 211) % 5000})`);
    followerRows.push(`(${q(DEMO.accountId)}, ${q(dateOnly(ms))}, ${1200 + (29 - d) * 17})`);
  }
  out.push(
    `INSERT INTO daily_views (account_id, date, views) VALUES\n${dailyRows.join(",\n")};`,
    `INSERT INTO follower_snapshots (account_id, date, followers) VALUES\n${followerRows.join(",\n")};`,
  );

  // クリックの週グリッド（直近4週ぶん）
  const clickRows: string[] = [];
  for (let w = 0; w < 4; w++) {
    const weekEnd = dateOnly(DEMO.epoch - w * 7 * 86400_000);
    for (const l of LINKS) {
      clickRows.push(
        `(${q(DEMO.accountId)}, ${q(weekEnd)}, ${q(l.url)}, ${40 + w * 7 + (l.kind === "line" ? 30 : 0)}, ${q(iso(DEMO.epoch))})`,
      );
    }
  }
  out.push(
    `INSERT INTO click_weeks (account_id, week_end, url, clicks, fetched_at) VALUES\n${clickRows.join(",\n")};`,
  );

  // キュー3件（draft / scheduled / done）
  const queueRows: Array<[string, string, string | null, string, string]> = [
    ["66666666-6666-4666-8666-000000000001", "draft", null, "下書きのままの投稿です。\nあとで日時を決めます。", "[]"],
    [
      "66666666-6666-4666-8666-000000000002",
      "scheduled",
      iso(DEMO.epoch + 86400_000),
      "明日の21時に出る予約投稿です。\n1行目で誰に向けた話かを言います。",
      JSON.stringify(["続きはこちら https://lin.ee/threadsdemo"]),
    ],
    [
      "66666666-6666-4666-8666-000000000003",
      "done",
      iso(DEMO.epoch - 86400_000),
      "投稿済みのキューです。",
      "[]",
    ],
  ];
  for (const [id, status, scheduledAt, body, comments] of queueRows) {
    const tags = buildTags(body, new Date(scheduledAt ?? iso(DEMO.epoch)), DEMO.tz, { link: "comment" });
    out.push(
      `INSERT INTO queue (id, account_id, status, scheduled_at, body, comments_json, image_url,
          reply_control, source, approval_mode, approve_deadline, notified_at, action_token_used_at,
          step, next_step_at, container_id, container_polls, result_ids_json, error, error_raw, attempts,
          tags_json, origin_post_id, source_ids_json, created_at, updated_at)
       VALUES (${q(id)}, ${q(DEMO.accountId)}, ${q(status)}, ${q(scheduledAt)}, ${q(body)}, ${q(comments)},
          NULL, 'everyone', 'manual', NULL, NULL, NULL, NULL, 0, NULL, NULL, 0, '[]', NULL, NULL, 0,
          ${q(JSON.stringify(tags))}, NULL, '[]', ${q(created)}, ${q(created)});`,
    );
  }

  // learning（型別・枠別。n<10 の行も混ぜて「集計中」表示を確認できるようにする）
  const learningRows: string[] = [];
  const hookCounts: Record<string, number> = {};
  for (let i = 0; i < 15; i++) {
    const hook = classifyHook(BODIES[i]!);
    hookCounts[hook] = (hookCounts[hook] ?? 0) + 1;
  }
  for (const [hook, n] of Object.entries(hookCounts)) {
    learningRows.push(
      `(${q(DEMO.accountId)}, 'hook', ${q(hook)}, ${n}, ${(n * 0.62).toFixed(2)}, ${n * 2800}, ${(n * 0.031).toFixed(4)}, ${q(iso(DEMO.epoch))})`,
    );
  }
  for (const [value, n] of [
    ["weekday-21", 12],
    ["weekend-12", 4],
  ] as Array<[string, number]>) {
    learningRows.push(
      `(${q(DEMO.accountId)}, 'slot', ${q(value)}, ${n}, ${(n * 0.58).toFixed(2)}, ${n * 3100}, ${(n * 0.029).toFixed(4)}, ${q(iso(DEMO.epoch))})`,
    );
  }
  out.push(
    `INSERT INTO learning (account_id, dim, value, n, score_sum, views_sum, like_rate_sum, updated_at)
     VALUES\n${learningRows.join(",\n")};`,
  );

  out.push("COMMIT;");
  return out.join("\n\n") + "\n";
}

/* ── 実行 ─────────────────────────────────────────── */

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

async function main(): Promise<void> {
  const email = arg("email", "demo@example.com");
  const remote = process.argv.includes("--remote");
  const sql = buildSql(email, await demoTokenEnc());

  if (process.argv.includes("--sql-only")) {
    process.stdout.write(sql);
    return;
  }

  const dir = mkdtempSync(path.join(tmpdir(), "tap-seed-"));
  const file = path.join(dir, "seed-demo.sql");
  writeFileSync(file, sql, "utf8");

  const args = [
    "wrangler",
    "d1",
    "execute",
    "threads-autopilot",
    remote ? "--remote" : "--local",
    "--file",
    file,
  ];
  console.log(`seed-demo: ${remote ? "remote" : "local"} D1 に投入します（email=${email}）`);
  const res = spawnSync("npx", args, { stdio: "inherit", cwd: ROOT });
  if (res.status !== 0) {
    console.error(
      "seed-demo: 失敗しました。先に `npm run db:migrate` でマイグレーションを流してください。",
    );
    process.exit(res.status ?? 1);
  }
  console.log(
    `seed-demo: 完了。root 15本 + コメント5本 = 投稿20本、日別30日分を投入しました。\n` +
      `  ログイン: ${email} / password1234`,
  );
}

void main();

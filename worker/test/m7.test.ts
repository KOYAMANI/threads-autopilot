/**
 * M7（SPEC §13 M7）のテスト。
 *
 * 1. 3アカウントで数字とキューが混ざらない（dashboard / queue / autopilot が分離）
 * 2. 同じ Threads アカウントを2ユーザーが接続してもデータが混ざらない（主キーの確認）
 * 3. 退会でユーザーに紐づく行が全テーブルから消え、ライセンスが revoked、セッションが無効
 * 4. CSV が UTF-8 BOM 付きで、ヘッダと行数が合う
 * 5. `/ai/generate` の回数制限（1分10回）
 * 6. アカウント上限3件、削除
 * 7. `daily_digest`（`digest_hour` の時刻にだけ送り、同じ日に二度送らない）
 * 8. Web Push の配線（鍵が無ければ送らない・`push_enabled` の判定・410 で行を消す・
 *    送ったボディが購読者の鍵で復号でき、承認URLを含まない）
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CSV_HEADERS, csvCell, formatCsvDate } from "../src/routes/export";
import { USER_TABLES } from "../src/routes/users";
import { ACCOUNT_CHILD_TABLES } from "../src/lib/accounts";
import { runDigest, previousDayRange, tzDateAndHour } from "../src/jobs/digest";
import { makeJobContext } from "../src/lib/jobs";
import { clearOutbox, getOutbox } from "../src/lib/email";
import { pushToUser } from "../src/lib/notify";
import { sha256Hex } from "../src/lib/crypto";
import { decryptPayload, generateVapidKeys } from "../src/lib/webpush";
import { api, countRows, insertAccount, registerUser, testDb } from "./helpers";
import { createApp } from "../src/app";

const rawApp = createApp();

/** バイト列で受け取りたいとき用（CSV の BOM 確認）。helpers の `api` は text() を通す。 */
async function rawGet(path: string, cookie: string): Promise<Response> {
  return rawApp.fetch(
    new Request(`https://test.local${path}`, {
      headers: { "X-Requested-With": "fetch", Cookie: cookie },
    }),
    env,
    { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
  );
}

async function insertPost(
  accountId: string,
  options: {
    id: string;
    postedAt: string;
    views?: number;
    likes?: number;
    text?: string;
    isReply?: boolean;
  },
): Promise<void> {
  const db = testDb();
  await db.run(
    `INSERT INTO posts (account_id, id, root_id, is_reply, text, permalink, media_type, media_url,
        link_attachment_url, posted_at, views, likes, replies, reposts, quotes, shares, clicks,
        metrics_fetched_at, tags_json, source, queue_id, deleted)
      VALUES (?,?,?,?,?,NULL,'TEXT_POST',NULL,NULL,?,?,?,0,0,0,0,0,NULL,'{"hook":"警告型","length":"100-200","slot":"21","daytype":"weekday"}','external',NULL,0)`,
    accountId,
    options.id,
    options.id,
    options.isReply ? 1 : 0,
    options.text ?? "本文",
    options.postedAt,
    options.views ?? 100,
    options.likes ?? 10,
  );
}

async function insertQueue(accountId: string, body: string): Promise<string> {
  const db = testDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO queue (id, account_id, status, scheduled_at, body, comments_json, image_url,
        reply_control, source, approval_mode, approve_deadline, notified_at, action_token_used_at,
        step, next_step_at, container_id, container_polls, result_ids_json, error, error_raw,
        attempts, tags_json, origin_post_id, source_ids_json, created_at, updated_at)
      VALUES (?,?,'draft',NULL,?,'[]',NULL,'everyone','manual',NULL,NULL,NULL,NULL,0,NULL,NULL,0,'[]',NULL,NULL,0,'{}',NULL,'[]',?,?)`,
    id,
    accountId,
    body,
    now,
    now,
  );
  return id;
}

/* ── 1. 3アカウントの分離 ─────────────────────────── */

describe("複数アカウント（SPEC §7.1 / §13 M7）", () => {
  it("3アカウントで dashboard / queue / autopilot が混ざらない", async () => {
    const user = await registerUser();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        await insertAccount({ userId: user.userId, threadsUserId: `1780000000000${i}` }),
      );
    }
    // アカウントごとに違う本数・違う数字を入れる
    const postedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await insertPost(ids[0]!, { id: "p0a", postedAt, views: 100 });
    await insertPost(ids[1]!, { id: "p1a", postedAt, views: 200 });
    await insertPost(ids[1]!, { id: "p1b", postedAt, views: 300 });
    await insertPost(ids[2]!, { id: "p2a", postedAt, views: 400 });

    await insertQueue(ids[0]!, "アカウント0の下書き");
    await insertQueue(ids[1]!, "アカウント1の下書き");
    await insertQueue(ids[1]!, "アカウント1の下書き2");

    const d0 = await api("GET", `/api/accounts/${ids[0]}/dashboard?period=30`, { cookie: user.cookie });
    const d1 = await api("GET", `/api/accounts/${ids[1]}/dashboard?period=30`, { cookie: user.cookie });
    const d2 = await api("GET", `/api/accounts/${ids[2]}/dashboard?period=30`, { cookie: user.cookie });
    expect(d0.body.data.posts).toHaveLength(1);
    expect(d1.body.data.posts).toHaveLength(2);
    expect(d2.body.data.posts).toHaveLength(1);
    const sum = (d: any) =>
      (d.body.data.posts as Array<{ views: number }>).reduce((n, p) => n + p.views, 0);
    expect(sum(d0)).toBe(100);
    expect(sum(d1)).toBe(500);
    expect(sum(d2)).toBe(400);

    const q0 = await api("GET", `/api/accounts/${ids[0]}/queue`, { cookie: user.cookie });
    const q1 = await api("GET", `/api/accounts/${ids[1]}/queue`, { cookie: user.cookie });
    const q2 = await api("GET", `/api/accounts/${ids[2]}/queue`, { cookie: user.cookie });
    expect(q0.body.data.items).toHaveLength(1);
    expect(q1.body.data.items).toHaveLength(2);
    expect(q2.body.data.items).toHaveLength(0);
    expect(q0.body.data.items[0].body).toBe("アカウント0の下書き");

    // オートパイロットの設定は account_id ごと（1つ変えても他に波及しない）
    const put = await api("PUT", `/api/accounts/${ids[1]}/autopilot`, {
      cookie: user.cookie,
      body: { perWeek: 14, dailyLimit: 2 },
    });
    expect(put.status).toBe(200);
    const a0 = await api("GET", `/api/accounts/${ids[0]}/autopilot`, { cookie: user.cookie });
    const a1 = await api("GET", `/api/accounts/${ids[1]}/autopilot`, { cookie: user.cookie });
    expect(a1.body.data.settings.perWeek).toBe(14);
    expect(a0.body.data.settings.perWeek).toBe(7);
  });

  it("4件目のアカウントは断られる（ACCOUNT_LIMIT=3）", async () => {
    const user = await registerUser();
    for (let i = 0; i < 3; i++) {
      await insertAccount({ userId: user.userId, threadsUserId: `1790000000000${i}` });
    }
    const res = await api("POST", "/api/accounts", {
      cookie: user.cookie,
      body: { token: "THAAdemo_limit" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ACCOUNT_LIMIT");
  });

  it("同じ Threads アカウントを2ユーザーが接続してもデータが混ざらない", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const shared = "17801111111111";
    const accA = await insertAccount({ userId: a.userId, threadsUserId: shared });
    const accB = await insertAccount({ userId: b.userId, threadsUserId: shared });
    const postedAt = new Date(Date.now() - 86_400_000).toISOString();
    // Threads 側の media id は同じ（別ユーザーが同じ投稿を持つ）
    await insertPost(accA, { id: "same-media-id", postedAt, views: 10, text: "Aの控え" });
    await insertPost(accB, { id: "same-media-id", postedAt, views: 999, text: "Bの控え" });

    const da = await api("GET", `/api/accounts/${accA}/dashboard?period=30`, { cookie: a.cookie });
    const dbRes = await api("GET", `/api/accounts/${accB}/dashboard?period=30`, { cookie: b.cookie });
    expect(da.body.data.posts).toHaveLength(1);
    expect(da.body.data.posts[0].views).toBe(10);
    expect(da.body.data.posts[0].text).toBe("Aの控え");
    expect(dbRes.body.data.posts[0].views).toBe(999);
    expect(dbRes.body.data.posts[0].text).toBe("Bの控え");

    // 他人のアカウントは 404（本人確認）
    const cross = await api("GET", `/api/accounts/${accB}/dashboard?period=30`, { cookie: a.cookie });
    expect(cross.status).toBe(404);
  });

  it("アカウント削除で関連データが消え、他のアカウントは残る", async () => {
    const user = await registerUser();
    const keep = await insertAccount({ userId: user.userId, threadsUserId: "17802222222221" });
    const drop = await insertAccount({ userId: user.userId, threadsUserId: "17802222222222" });
    const postedAt = new Date().toISOString();
    await insertPost(keep, { id: "keep1", postedAt });
    await insertPost(drop, { id: "drop1", postedAt });
    await insertQueue(drop, "消える下書き");

    const res = await api("DELETE", `/api/accounts/${drop}`, { cookie: user.cookie });
    expect(res.status).toBe(200);

    for (const table of ACCOUNT_CHILD_TABLES) {
      expect(await countRows(table, "account_id=?", drop)).toBe(0);
    }
    expect(await countRows("accounts", "id=?", drop)).toBe(0);
    expect(await countRows("posts", "account_id=?", keep)).toBe(1);
  });
});

/* ── 2. 退会（SPEC §7.8） ─────────────────────────── */

describe("退会 DELETE /users/me（SPEC §7.8）", () => {
  it("パスワードが違えば消さない", async () => {
    const user = await registerUser();
    const res = await api("DELETE", "/api/users/me", {
      cookie: user.cookie,
      body: { password: "wrong-password" },
    });
    expect(res.status).toBe(401);
    expect(await countRows("users", "id=?", user.userId)).toBe(1);
  });

  it("全テーブルから消え、ライセンスが revoked、セッションが無効になる", async () => {
    const user = await registerUser();
    const acc = await insertAccount({ userId: user.userId, threadsUserId: "17803333333333" });
    const postedAt = new Date().toISOString();
    await insertPost(acc, { id: "gone1", postedAt });
    await insertQueue(acc, "消える下書き");
    const db = testDb();
    const now = new Date().toISOString();
    await db.run(
      "INSERT INTO sources (id, user_id, type, title, url, content, char_count, enabled_for_ap, last_used_at, use_count, created_at) VALUES (?,?,'text','ネタ',NULL,'本文',2,1,NULL,0,?)",
      crypto.randomUUID(),
      user.userId,
      now,
    );
    await db.run(
      "INSERT INTO ai_settings (user_id, provider, key_enc, model, store_on_server, updated_at) VALUES (?,'gemini','xxx','gemini-2.5-flash',1,?)",
      user.userId,
      now,
    );
    await db.run(
      `INSERT INTO notifications (user_id, email_enabled, push_enabled, digest_hour, updated_at)
         VALUES (?,1,0,8,?) ON CONFLICT(user_id) DO UPDATE SET email_enabled=1, digest_hour=8`,
      user.userId,
      now,
    );
    await db.run(
      "INSERT INTO push_subscriptions (id, user_id, json, created_at) VALUES (?,?,'x',?)",
      crypto.randomUUID(),
      user.userId,
      now,
    );
    await db.run("INSERT INTO rate_events (key, at) VALUES (?,?)", `login:${user.email}`, now);

    const res = await api("DELETE", "/api/users/me", {
      cookie: user.cookie,
      body: { password: "password1234" },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    // users / accounts / 子テーブル
    expect(await countRows("users", "id=?", user.userId)).toBe(0);
    expect(await countRows("accounts", "user_id=?", user.userId)).toBe(0);
    for (const table of ACCOUNT_CHILD_TABLES) {
      expect(await countRows(table, "account_id=?", acc)).toBe(0);
    }
    // user_id を持つテーブル
    for (const table of USER_TABLES) {
      expect(await countRows(table, "user_id=?", user.userId)).toBe(0);
    }
    // rate_events のキー付き行
    expect(await countRows("rate_events", "key=?", `login:${user.email}`)).toBe(0);

    // ライセンスは行が残り revoked、user_id は外れる
    const license = await testDb().first<{ status: string; user_id: string | null }>(
      "SELECT status, user_id FROM licenses WHERE id=?",
      user.licenseId,
    );
    expect(license?.status).toBe("revoked");
    expect(license?.user_id).toBeNull();

    // セッションは無効（同じ Cookie で /me が 401）
    const me = await api("GET", "/api/auth/me", { cookie: user.cookie });
    expect(me.status).toBe(401);

    // 監査ログはメールの平文を残さない
    const log = await testDb().first<{ detail: string | null }>(
      "SELECT detail FROM audit_log WHERE action='user_delete' ORDER BY at DESC LIMIT 1",
    );
    expect(log?.detail ?? "").not.toContain(user.email);
    expect(log?.detail ?? "").toContain("emailHash");
  });
});

/* ── 3. CSV 書き出し（SPEC §7.8） ─────────────────── */

describe("CSV 書き出し GET /export/:accountId", () => {
  it("BOM 付き UTF-8 で、ヘッダ1行＋投稿の行数が出る", async () => {
    const user = await registerUser();
    const acc = await insertAccount({ userId: user.userId, threadsUserId: "17804444444444" });
    const postedAt = new Date("2026-09-01T12:00:00Z").toISOString();
    await insertPost(acc, { id: "csv1", postedAt, text: "本文に、読点と\n改行と\"引用符\"が入る" });
    await insertPost(acc, { id: "csv2", postedAt, text: "2本目" });
    await testDb().run(
      "INSERT INTO post_metrics_history (account_id, post_id, checkpoint, at, views, likes, replies, reposts, quotes) VALUES (?,?, '48h', ?, 55, 6, 0,0,0)",
      acc,
      "csv1",
      postedAt,
    );

    const res = await rawGet(`/api/export/${acc}`, user.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");

    // **バイトで見る**。`Response.text()` は先頭の BOM を落とす仕様なので、
    // text() で確かめると「BOM を付けていない」のと区別がつかない
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const text = new TextDecoder().decode(bytes.slice(3));
    // CRLF 区切り。ヘッダ1行 + 投稿2行（末尾の空行を除く）
    const lines = text.split("\r\n").filter((l) => l !== "");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(CSV_HEADERS.map((h) => `"${h}"`).join(","));
    // 本文の改行と引用符が壊れず、セルの中に収まっている
    expect(text).toContain('""引用符""');
    // 48h の値が入る
    expect(lines.some((l) => l.includes('"55"'))).toBe(true);
  });

  it("format=json は断る。他人のアカウントは 404", async () => {
    const a = await registerUser();
    const b = await registerUser();
    const acc = await insertAccount({ userId: a.userId, threadsUserId: "17805555555555" });
    expect((await api("GET", `/api/export/${acc}?format=json`, { cookie: a.cookie })).status).toBe(400);
    expect((await api("GET", `/api/export/${acc}`, { cookie: b.cookie })).status).toBe(404);
  });

  it("csvCell は数式インジェクションを潰し、日時はアカウントの timezone で出る", () => {
    expect(csvCell("=SUM(A1:A2)")).toBe(`"'=SUM(A1:A2)"`);
    expect(csvCell('a"b')).toBe(`"a""b"`);
    expect(csvCell(null)).toBe(`""`);
    // 2026-09-01T12:00Z は JST で 21:00
    expect(formatCsvDate("2026-09-01T12:00:00Z", "Asia/Tokyo")).toBe("2026-09-01 21:00");
    expect(formatCsvDate("2026-09-01T12:00:00Z", "UTC")).toBe("2026-09-01 12:00");
  });
});

/* ── 4. ライセンス表示 ───────────────────────────── */

describe("ライセンス表示 GET /users/me/license", () => {
  it("末尾4桁と状態だけ返す（キー全体は返さない）", async () => {
    const user = await registerUser();
    const key = await testDb().first<{ key: string }>(
      "SELECT key FROM licenses WHERE id=?",
      user.licenseId,
    );
    const res = await api("GET", "/api/users/me/license", { cookie: user.cookie });
    expect(res.status).toBe(200);
    expect(res.body.data.license.keyTail).toBe(key!.key.slice(-4));
    expect(res.body.data.license.status).toBe("active");
    expect(JSON.stringify(res.body)).not.toContain(key!.key);
  });
});

/* ── 4-2. 監査ログ（SPEC §13 M7 / docs/qa.md M7-7） ── */

describe("監査ログ audit_log", () => {
  /** その買い手の記録を新しい順に。`user_delete` は user_id を持たないので別で引く。 */
  async function actionsOf(userId: string): Promise<string[]> {
    const rows = await testDb().all<{ action: string }>(
      "SELECT action FROM audit_log WHERE user_id=? ORDER BY at ASC",
      userId,
    );
    return rows.map((r) => r.action);
  }

  it("登録・ログイン・接続・キー変更・AP ON/OFF・書き出し・削除・退会が1件ずつ入る", async () => {
    const user = await registerUser();
    expect(await actionsOf(user.userId)).toContain("register");

    // ログイン（同じ買い手でもう1本セッションを作る）
    expect(
      (await api("POST", "/api/auth/login", {
        body: { email: user.email, password: "password1234" },
      })).status,
    ).toBe(200);

    // アカウントの接続（モックのトークン。SPEC §11）
    const connect = await api("POST", "/api/accounts", {
      cookie: user.cookie,
      body: { token: "THAAdemo_audit" },
    });
    expect(connect.status).toBe(201);
    const accountId = connect.body.data.account.id as string;

    // AIキーの保存
    expect(
      (await api("PUT", "/api/ai/settings", {
        cookie: user.cookie,
        body: { acceptDataPolicy: true, geminiBillingConfirmed: true, provider: "gemini", key: "AIzaSecretKeyValue123456", storeOnServer: true },
      })).status,
    ).toBe(200);

    // オートパイロットの ON（AIキーと参考情報が要るので、まず参考情報を1件）
    await api("POST", "/api/sources", {
      cookie: user.cookie,
      body: { type: "text", title: "ネタ", content: "本文".repeat(20) },
    });
    await api("PUT", `/api/accounts/${accountId}/autopilot`, {
      cookie: user.cookie,
      body: { enabled: true },
    });
    await api("PUT", `/api/accounts/${accountId}/autopilot`, {
      cookie: user.cookie,
      body: { enabled: false },
    });

    // 書き出しと、アカウントの削除
    expect((await api("GET", `/api/export/${accountId}`, { cookie: user.cookie })).status).toBe(200);
    expect((await api("DELETE", `/api/accounts/${accountId}`, { cookie: user.cookie })).status).toBe(200);

    const actions = await actionsOf(user.userId);
    for (const want of [
      "register",
      "login",
      "account_connect",
      "ai_key_change",
      "autopilot.on",
      "autopilot.off",
      "export",
      "account_delete",
    ]) {
      expect(actions).toContain(want);
    }

    // detail に秘密（AIキー・トークン・パスワード）が入っていない
    const details = await testDb().all<{ detail: string | null }>(
      "SELECT detail FROM audit_log WHERE user_id=?",
      user.userId,
    );
    const blob = details.map((d) => d.detail ?? "").join("\n");
    expect(blob).not.toContain("AIzaSecretKeyValue123456");
    expect(blob).not.toContain("THAAdemo_audit");
    expect(blob).not.toContain("password1234");

    // 退会は user_id を持たない行として1件だけ入る
    expect(
      (await api("DELETE", "/api/users/me", {
        cookie: user.cookie,
        body: { password: "password1234" },
      })).status,
    ).toBe(200);
    const hash = await sha256Hex(user.email.trim().toLowerCase());
    const deletes = await testDb().all<{ detail: string | null }>(
      "SELECT detail FROM audit_log WHERE action='user_delete'",
    );
    expect(deletes.filter((d) => (d.detail ?? "").includes(hash))).toHaveLength(1);
    // ハッシュだけで、メールの平文はどこにも無い
    expect(deletes.map((d) => d.detail ?? "").join("\n")).not.toContain(user.email);
  });

  it("ライセンスの発行と失効が入り、キー本体は detail に出ない", async () => {
    const admin = { "X-Admin-Secret": env.ADMIN_SECRET! };
    const issued = await api("POST", "/api/admin/licenses", {
      body: { count: 2, note: "監査テスト" },
      headers: admin,
    });
    expect(issued.status).toBe(201);
    const first = issued.body.data.keys[0] as { id: string; key: string };

    const revoked = await api("POST", `/api/admin/licenses/${first.id}/revoke`, {
      body: {},
      headers: admin,
    });
    expect(revoked.status).toBe(200);

    const rows = await testDb().all<{ action: string; detail: string | null }>(
      "SELECT action, detail FROM audit_log WHERE action IN ('license_issue','license_revoke')",
    );
    expect(rows.some((r) => r.action === "license_issue")).toBe(true);
    expect(rows.some((r) => r.action === "license_revoke" && (r.detail ?? "").includes(first.id))).toBe(true);
    // 在庫の流出になるのでキー本体は書かない
    expect(rows.map((r) => r.detail ?? "").join("\n")).not.toContain(first.key);
  });
});

/* ── 5. AI の回数制限（M7） ──────────────────────── */

describe("AI の回数制限（1分10回）", () => {
  it("11回目が 429 になる", async () => {
    const user = await registerUser();
    const acc = await insertAccount({ userId: user.userId, threadsUserId: "17806666666666" });
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await api("POST", "/api/ai/generate", {
        cookie: user.cookie,
        body: { accountId: acc, instruction: "テスト", n: 1 },
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

/* ── 6. 日次ダイジェスト（M7） ───────────────────── */

describe("daily_digest（notifications.digest_hour）", () => {
  beforeEach(() => clearOutbox());

  it("timezone の日付と時刻を正しく取り出す", () => {
    // 2026-09-06T13:30Z = JST 2026-09-06 22:30
    const now = new Date("2026-09-06T13:30:00Z");
    expect(tzDateAndHour(now, "Asia/Tokyo")).toEqual({ date: "2026-09-06", hour: 22 });
    expect(tzDateAndHour(now, "UTC")).toEqual({ date: "2026-09-06", hour: 13 });
    const range = previousDayRange(now, "Asia/Tokyo");
    expect(range.label).toBe("2026-09-05");
    expect(range.from).toBe("2026-09-04T15:00:00.000Z"); // JST 9/5 00:00
    expect(range.to).toBe("2026-09-05T15:00:00.000Z"); // JST 9/6 00:00
  });

  it("digest_hour の時刻に1通だけ送り、同じ日は二度送らない", async () => {
    const user = await registerUser();
    const acc = await insertAccount({ userId: user.userId, threadsUserId: "17807777777777" });
    // 前日（JST 9/5）の投稿
    await insertPost(acc, { id: "dig1", postedAt: "2026-09-05T03:00:00Z", views: 1234, likes: 45 });
    await testDb().run(
      `INSERT INTO notifications (user_id, email_enabled, push_enabled, digest_hour, updated_at)
         VALUES (?,1,0,8,?) ON CONFLICT(user_id) DO UPDATE SET email_enabled=1, digest_hour=8`,
      user.userId,
      new Date().toISOString(),
    );

    // このテストの買い手あてだけを数える（同じファイルの他のテストが作った買い手も
    // 同じ D1 に残っていて、8時の回では一緒に拾われるため）
    const mine = () =>
      getOutbox().filter((m) => m.template === "daily_digest" && m.to === user.email);

    // JST 7時 → 送らない
    let ctx = makeJobContext(env, { now: new Date("2026-09-05T22:00:00Z") });
    await runDigest(ctx);
    expect(mine()).toHaveLength(0);

    // JST 8時 → 送る
    ctx = makeJobContext(env, { now: new Date("2026-09-05T23:00:00Z") });
    await runDigest(ctx);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]!.text).toContain("1,234");
    expect(mine()[0]!.text).toContain("2026-09-05");

    // 同じ日にもう一度回しても送らない
    ctx = makeJobContext(env, { now: new Date("2026-09-05T23:30:00Z") });
    await runDigest(ctx);
    expect(mine()).toHaveLength(1);
  });

  it("メール通知がオフなら送らない", async () => {
    const user = await registerUser();
    await insertAccount({ userId: user.userId, threadsUserId: "17808888888888" });
    await testDb().run(
      `INSERT INTO notifications (user_id, email_enabled, push_enabled, digest_hour, updated_at)
         VALUES (?,0,0,8,?) ON CONFLICT(user_id) DO UPDATE SET email_enabled=0, digest_hour=8`,
      user.userId,
      new Date().toISOString(),
    );
    const ctx = makeJobContext(env, { now: new Date("2026-09-05T23:00:00Z") });
    await runDigest(ctx);
    expect(
      getOutbox().filter((m) => m.template === "daily_digest" && m.to === user.email),
    ).toHaveLength(0);
  });
});

/* ── 7. Web Push の実送信の配線（M7） ───────────────── */

describe("pushToUser（lib/notify.ts）", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** 購読を1件作って `push_subscriptions` に暗号化して入れる（`POST /push/subscribe` と同じ形）。 */
  async function subscribe(cookie: string): Promise<string> {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );
    const b64u = (b: Uint8Array) =>
      btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const endpoint = `https://push.example.com/send/${crypto.randomUUID()}`;
    const res = await api("POST", "/api/push/subscribe", {
      cookie,
      body: {
        endpoint,
        keys: { p256dh: b64u(raw), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) },
      },
    });
    expect(res.status).toBe(201);
    return endpoint;
  }

  const withVapid = async () => ({
    ...env,
    VAPID_PUBLIC_KEY: (await generateVapidKeys()).publicKey,
    VAPID_PRIVATE_KEY: (await generateVapidKeys()).privateKey,
  });

  it("鍵が無ければ何もしない", async () => {
    const user = await registerUser();
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const out = await pushToUser({ ...env, VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" }, testDb(), user.userId, {
      title: "t",
      body: "b",
    });
    expect(out).toEqual({ sent: 0, removed: 0 });
    expect(called).toBe(0);
  });

  it("push_enabled=0 なら送らない。1 なら送る", async () => {
    const user = await registerUser();
    await subscribe(user.cookie);
    const keys = await generateVapidKeys();
    const e = { ...env, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };

    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    // 既定は push_enabled=0
    expect(await pushToUser(e, testDb(), user.userId, { title: "t", body: "b" })).toEqual({
      sent: 0,
      removed: 0,
    });
    expect(called).toBe(0);

    await api("PUT", "/api/notifications", { cookie: user.cookie, body: { pushEnabled: true } });
    expect(await pushToUser(e, testDb(), user.userId, { title: "t", body: "b" })).toEqual({
      sent: 1,
      removed: 0,
    });
    expect(called).toBe(1);
  });

  it("410 が返った購読は行ごと消す", async () => {
    const user = await registerUser();
    await subscribe(user.cookie);
    await api("PUT", "/api/notifications", { cookie: user.cookie, body: { pushEnabled: true } });
    const keys = await generateVapidKeys();
    const e = { ...env, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };

    globalThis.fetch = (async () => new Response(null, { status: 410 })) as typeof fetch;
    const out = await pushToUser(e, testDb(), user.userId, { title: "t", body: "b" });
    expect(out).toEqual({ sent: 0, removed: 1 });
    expect(await countRows("push_subscriptions", "user_id=?", user.userId)).toBe(0);
  });

  it("500 は行を残して fail_count を進める", async () => {
    const user = await registerUser();
    await subscribe(user.cookie);
    await api("PUT", "/api/notifications", { cookie: user.cookie, body: { pushEnabled: true } });
    const keys = await generateVapidKeys();
    const e = { ...env, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };

    globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    await pushToUser(e, testDb(), user.userId, { title: "t", body: "b" });
    const row = await testDb().first<{ fail_count: number; last_error_at: string | null }>(
      "SELECT fail_count, last_error_at FROM push_subscriptions WHERE user_id=?",
      user.userId,
    );
    expect(row?.fail_count).toBe(1);
    expect(row?.last_error_at).not.toBeNull();
  });

  it("送ったボディは購読者の鍵で復号でき、承認URLを含まない", async () => {
    const user = await registerUser();
    // 購読者側の鍵をこちらで持っておく
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );
    const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const b64u = (b: Uint8Array) =>
      btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await api("POST", "/api/push/subscribe", {
      cookie: user.cookie,
      body: {
        endpoint: "https://push.example.com/send/roundtrip",
        keys: { p256dh: b64u(raw), auth: b64u(authSecret) },
      },
    });
    await api("PUT", "/api/notifications", { cookie: user.cookie, body: { pushEnabled: true } });

    const keys = await generateVapidKeys();
    const e = { ...env, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };

    let body: Uint8Array | null = null;
    let auth = "";
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      body = new Uint8Array(init.body as ArrayBuffer);
      auth = String((init.headers as Record<string, string>).Authorization ?? "");
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;

    await pushToUser(e, testDb(), user.userId, {
      title: "下書きを承認してください",
      body: "9/11 21:00",
      url: "/app/queue",
    });

    expect(auth).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const plain = await decryptPayload(body!, privateJwk, authSecret);
    const parsed = JSON.parse(plain) as { title: string; url: string };
    expect(parsed.title).toBe("Threads オートパイロット");
    expect(plain).not.toContain("9/11 21:00");
    expect(parsed.url).toBe("/app/queue");
    // ワンタイムの承認/取消 URL は入れない（jobs/notify.ts のコメント）
    expect(plain).not.toContain("/a/");
  });
});

/* ── 9. VAPID の連絡先が使えないときは送らない（M7） ── */

describe("VAPID subject（RFC 8292）", () => {
  it("http:// の APP_ORIGIN しか無ければ送らない（mailto: か https: が要る）", async () => {
    const user = await registerUser();
    await api("PUT", "/api/notifications", { cookie: user.cookie, body: { pushEnabled: true } });
    const keys = await generateVapidKeys();
    let called = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      called++;
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    try {
      const out = await pushToUser(
        {
          ...env,
          VAPID_PUBLIC_KEY: keys.publicKey,
          VAPID_PRIVATE_KEY: keys.privateKey,
          VAPID_SUBJECT: "",
          APP_ORIGIN: "http://localhost:5173",
        },
        testDb(),
        user.userId,
        { title: "t", body: "b" },
      );
      expect(out).toEqual({ sent: 0, removed: 0 });
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = real;
    }
  });
});

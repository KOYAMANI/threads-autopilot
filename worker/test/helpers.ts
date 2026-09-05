import { env } from "cloudflare:test";
import { createApp } from "../src/app";
import { createBudget } from "../src/lib/budget";
import { createDb, type Db } from "../src/lib/db";
import { generateLicenseKey } from "../src/lib/crypto";

const app = createApp();

/** 予算を大きめに取った素の Db（テスト内の直接操作用）。 */
export function testDb(): Db {
  return createDb(env.DB, createBudget({ subrequests: 1e6, dbQueries: 1e6, timeMs: 1e9 }));
}

export type ApiCall = {
  status: number;
  body: any;
  cookie: string | null;
  headers: Headers;
};

/** /api/* を叩く。変更系には X-Requested-With を自動で付ける。 */
export async function api(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string | null; headers?: Record<string, string>; xrw?: boolean } = {},
): Promise<ApiCall> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.xrw !== false) headers["X-Requested-With"] = "fetch";
  if (options.cookie) headers["Cookie"] = options.cookie;

  const init: RequestInit = { method, headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  const res = await app.fetch(new Request(`https://test.local${path}`, init), env, {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext);

  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const setCookie = res.headers.get("Set-Cookie");
  const cookie = setCookie ? (setCookie.split(";")[0] ?? null) : null;
  return { status: res.status, body, cookie, headers: res.headers };
}

/** 未使用ライセンスを1本作って key を返す。 */
export async function issueLicense(note = "test"): Promise<{ id: string; key: string }> {
  const db = testDb();
  const id = crypto.randomUUID();
  const key = generateLicenseKey();
  await db.run(
    "INSERT INTO licenses (id, key, status, note, issued_at) VALUES (?,?,'unused',?,?)",
    id,
    key,
    note,
    new Date().toISOString(),
  );
  return { id, key };
}

let seq = 0;
export function uniqueEmail(prefix = "user"): string {
  return `${prefix}${Date.now()}${seq++}@example.com`;
}

/** register まで済ませて Cookie とユーザー情報を返す。 */
export async function registerUser(
  password = "password1234",
): Promise<{ email: string; cookie: string; licenseId: string; userId: string }> {
  const license = await issueLicense();
  const email = uniqueEmail();
  const res = await api("POST", "/api/auth/register", {
    body: { email, password, license_key: license.key },
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return {
    email,
    cookie: res.cookie!,
    licenseId: license.id,
    userId: res.body.data.user.id as string,
  };
}

/* ── M2: アカウントとジョブ ─────────────────────────── */

import { encrypt } from "../src/lib/crypto";

/** モックに入るトークン（SPEC §11）。テストごとに別の store になるよう接尾辞を変える。 */
export function mockToken(suffix = "t"): string {
  return `THAAdemo_${suffix}`;
}

/** accounts 行を直接作る（POST /accounts を通さずにジョブだけ試したいとき）。 */
export async function insertAccount(options: {
  userId: string;
  token?: string;
  threadsUserId?: string;
  timezone?: string;
  status?: string;
  createdAt?: string;
  longLived?: boolean;
  tokenObtainedAt?: string;
}): Promise<string> {
  const db = testDb();
  const id = crypto.randomUUID();
  const nowIso = options.createdAt ?? new Date().toISOString();
  await db.run(
    `INSERT INTO accounts (id, user_id, threads_user_id, username, name, avatar_url, color,
        token_enc, token_obtained_at, token_long_lived, token_last_refresh_at, status,
        timezone, settings_json, last_full_sync_at, created_at)
      VALUES (?,?,?,?,?,NULL,'#4f7cff',?,?,?,NULL,?,?, '{}', NULL, ?)`,
    id,
    options.userId,
    options.threadsUserId ?? `1780000000000${Math.floor(Math.random() * 900 + 100)}`,
    "demo_test",
    "デモアカウント",
    await encrypt(options.token ?? mockToken(), env.ENC_KEY),
    options.tokenObtainedAt ?? nowIso,
    options.longLived ? 1 : 0,
    options.status ?? "ok",
    options.timezone ?? "Asia/Tokyo",
    nowIso,
  );
  await db.run(
    "INSERT INTO autopilot (account_id, updated_at) VALUES (?,?) ON CONFLICT(account_id) DO NOTHING",
    id,
    nowIso,
  );
  return id;
}

export async function countRows(table: string, where: string, ...params: unknown[]): Promise<number> {
  const row = await testDb().first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
    ...params,
  );
  return row?.n ?? 0;
}

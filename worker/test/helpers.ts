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

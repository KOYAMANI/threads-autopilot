import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, registerUser, testDb, insertAccount } from "./helpers";
import { encrypt, decrypt } from "../src/lib/crypto";
import { makeJobContext, type RunningJob } from "../src/lib/jobs";
import {
  enqueueSheetSyncs,
  sheetsSyncJob,
  SHEET_TABS,
} from "../src/jobs/sheets";
import { googleRequest } from "../src/lib/google";

beforeEach(async () => {
  env.GOOGLE_CLIENT_ID = "test-client";
  env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  for (const t of [
    "google_connections",
    "google_oauth_states",
    "google_api_budget",
    "jobs",
  ])
    await testDb().run(`DELETE FROM ${t}`);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete env.GOOGLE_CLIENT_ID;
  delete env.GOOGLE_CLIENT_SECRET;
});
function installGoogle() {
  const calls: Array<{ url: string; body: string }> = [];
  let created = false;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input),
        body = String(init?.body ?? "");
      calls.push({ url, body });
      if (url === "https://oauth2.googleapis.com/token")
        return Response.json({
          access_token: "test-access",
          refresh_token: "test-refresh-secret",
          scope: "openid https://www.googleapis.com/auth/drive.file",
        });
      if (url.includes("/userinfo"))
        return Response.json({ sub: "test-google-sub" });
      if (url.includes("/drive/v3/files?") && init?.method === "GET")
        return Response.json({
          files: created ? [{ id: "review-sheet" }] : [],
        });
      if (url.includes("/drive/v3/files?") && init?.method === "POST") {
        created = true;
        return Response.json({ id: "review-sheet" });
      }
      if (url.includes("?fields=sheets.properties"))
        return Response.json({
          sheets: Array.from({ length: 6 }, (_, sheetId) => ({
            properties: {
              sheetId,
              gridProperties: { rowCount: 1000, columnCount: 20 },
            },
          })),
        });
      if (url.endsWith(":batchUpdate")) return Response.json({});
      throw new Error("unexpected outbound request");
    },
  );
  return calls;
}
it("OAuth binds state to the original user, session and browser, and consumes it once", async () => {
  const a = await registerUser(),
    b = await registerUser(),
    calls = installGoogle();
  const start = await api("POST", "/api/google/start", { cookie: a.cookie });
  expect(start.status).toBe(200);
  const url = new URL(start.body.data.url),
    state = url.searchParams.get("state");
  expect(url.searchParams.get("scope")).toBe(
    "openid https://www.googleapis.com/auth/drive.file",
  );
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const body = { state, code: "test-code" };
  expect(
    (
      await api("POST", "/api/google/complete", {
        cookie: b.cookie + "; " + start.cookie,
        body,
      })
    ).status,
  ).toBe(400);
  expect(
    (await api("POST", "/api/google/complete", { cookie: a.cookie, body }))
      .status,
  ).toBe(400);
  const complete = await api("POST", "/api/google/complete", {
    cookie: a.cookie + "; " + start.cookie,
    body,
  });
  expect(complete.status).toBe(200);
  expect(
    (
      await api("POST", "/api/google/complete", {
        cookie: a.cookie + "; " + start.cookie,
        body,
      })
    ).status,
  ).toBe(400);
  expect(calls.filter((x) => x.url.includes("/token"))).toHaveLength(1);
  const row = await testDb().first<{ refresh_enc: string }>(
    "SELECT refresh_enc FROM google_connections WHERE user_id=?",
    a.userId,
  );
  expect(row!.refresh_enc).not.toContain("test-refresh-secret");
  expect(await decrypt(row!.refresh_enc, env.ENC_KEY)).toBe(
    "test-refresh-secret",
  );
  const status = await api("GET", "/api/google/status", { cookie: a.cookie });
  expect(status.headers.get("Cache-Control")).toBe("no-store");
  expect(JSON.stringify(status.body)).not.toContain("secret");
  expect(
    (await api("GET", "/api/google/status", { cookie: b.cookie })).body.data
      .connected,
  ).toBe(false);
});
it("logged-out OAuth flows cannot complete and callback script escapes hostile text", async () => {
  const a = await registerUser();
  const start = await api("POST", "/api/google/start", { cookie: a.cookie });
  await api("POST", "/api/auth/logout", { cookie: a.cookie });
  expect(
    (
      await api("POST", "/api/google/complete", {
        cookie: a.cookie + "; " + start.cookie,
        body: {
          state: new URL(start.body.data.url).searchParams.get("state"),
          code: "test",
        },
      })
    ).status,
  ).toBe(401);
  const callback = await api(
    "GET",
    "/api/google/callback?code=" +
      encodeURIComponent("</script><script>evil()</script>"),
  );
  expect(callback.status).toBe(200);
  expect(callback.body).not.toContain("</script><script>evil");
  expect(callback.headers.get("Content-Security-Policy")).toContain(
    "default-src 'none'",
  );
});
it("creates a private sheet and exports only the current users allowlisted data as literal cells", async () => {
  const a = await registerUser(),
    b = await registerUser(),
    db = testDb();
  const accountId = await insertAccount({ userId: a.userId });
  const other = await insertAccount({ userId: b.userId });
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO google_connections(user_id,refresh_enc,next_sync_at,updated_at) VALUES (?,?,?,?)",
    a.userId,
    await encrypt("test-refresh-secret", env.ENC_KEY),
    now,
    now,
  );
  for (const [owner, id, text] of [
    [accountId, "visible", '=IMPORTDATA("https://example.com")'],
    [other, "private", "other-student-private"],
  ])
    await db.run(
      "INSERT INTO posts(account_id,id,root_id,text,posted_at) VALUES (?,?,?,?,?)",
      owner,
      id,
      id,
      text,
      now,
    );
  await api("PUT", "/api/ai/settings", {
    cookie: a.cookie,
    body: { provider: "gemini", key: "test-ai-secret", storeOnServer: true },
  });
  const calls = installGoogle();
  const job: RunningJob = {
    id: "sync",
    type: "sheets_sync",
    accountId: null,
    attempts: 0,
    state: { userId: a.userId },
  };
  await sheetsSyncJob(makeJobContext(env), job);
  const writes = calls
    .filter((c) => c.url.endsWith(":batchUpdate"))
    .map((c) => c.body)
    .join("\n");
  expect(writes).toContain("IMPORTDATA");
  expect(writes).toContain("stringValue");
  expect(writes).not.toContain("formulaValue");
  for (const secret of [
    "test-refresh-secret",
    "test-ai-secret",
    "other-student-private",
    "token_enc",
    "refresh_enc",
    "key_enc",
  ])
    expect(writes).not.toContain(secret);
  expect(calls.some((c) => c.url.includes("/permissions"))).toBe(false);
  expect(
    (
      await db.first<{ last_sync_at: string }>(
        "SELECT last_sync_at FROM google_connections WHERE user_id=?",
        a.userId,
      )
    )?.last_sync_at,
  ).toBeTruthy();
  expect(SHEET_TABS).toHaveLength(5);
});
it("deleted sheets stop with a safe error; credentials and Google response bodies are not exposed", async () => {
  const a = await registerUser(),
    db = testDb(),
    now = new Date().toISOString();
  await db.run(
    "INSERT INTO google_connections(user_id,refresh_enc,spreadsheet_id,next_sync_at,updated_at) VALUES (?,?,?,?,?)",
    a.userId,
    await encrypt("test-secret", env.ENC_KEY),
    "deleted-sheet",
    now,
    now,
  );
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input).includes("/token")
      ? Response.json({ access_token: "test-access" })
      : Response.json({ error: "secret-provider-message" }, { status: 404 }),
  );
  await sheetsSyncJob(makeJobContext(env), {
    id: "sync",
    type: "sheets_sync",
    accountId: null,
    attempts: 0,
    state: { userId: a.userId },
  });
  const status = await api("GET", "/api/google/status", { cookie: a.cookie });
  expect(status.body.data.status).toBe("needs_attention");
  expect(JSON.stringify(status.body)).not.toContain("secret");
});
it("pending synchronizations deduplicate and disconnected users are never enqueued", async () => {
  const a = await registerUser(),
    db = testDb(),
    now = new Date().toISOString();
  await db.run(
    "INSERT INTO google_connections(user_id,refresh_enc,next_sync_at,updated_at) VALUES (?,?,?,?)",
    a.userId,
    "encrypted-dummy",
    now,
    now,
  );
  await enqueueSheetSyncs(makeJobContext(env));
  await enqueueSheetSyncs(makeJobContext(env));
  expect(
    (
      await db.first<{ n: number }>(
        "SELECT COUNT(*) n FROM jobs WHERE type='sheets_sync'",
      )
    )?.n,
  ).toBe(1);
  await api("DELETE", "/api/google/connection", { cookie: a.cookie });
  await enqueueSheetSyncs(makeJobContext(env));
  expect(
    (
      await db.first<{ n: number }>(
        "SELECT COUNT(*) n FROM jobs WHERE type='sheets_sync'",
      )
    )?.n,
  ).toBe(0);
});
it("global Google budget rejects excess operations before sending HTTP", async () => {
  const ctx = makeJobContext(env);
  const key = new Date().toISOString().slice(0, 16) + ":write";
  await testDb().run(
    "INSERT INTO google_api_budget(bucket,n) VALUES (?,150)",
    key,
  );
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    googleRequest(
      ctx.db,
      ctx.budget,
      "https://sheets.googleapis.com/v4/spreadsheets/test:batchUpdate",
      { method: "POST" },
    ),
  ).rejects.toThrow("混み合っています");
  expect(fetch).not.toHaveBeenCalled();
});

it("logout during a Google token exchange cannot resurrect a saved connection", async () => {
  const a = await registerUser(),
    db = testDb();
  const start = await api("POST", "/api/google/start", { cookie: a.cookie });
  let signal!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => {
      signal = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input).includes("/token")) {
      signal();
      await gate;
      return Response.json({
        access_token: "test-access",
        refresh_token: "test-refresh",
        scope: "openid https://www.googleapis.com/auth/drive.file",
      });
    }
    return Response.json({ sub: "test-google-sub" });
  });
  const completing = api("POST", "/api/google/complete", {
    cookie: a.cookie + "; " + start.cookie,
    body: {
      state: new URL(start.body.data.url).searchParams.get("state"),
      code: "test-code",
    },
  });
  await reached;
  await api("POST", "/api/auth/logout", { cookie: a.cookie });
  release();
  expect((await completing).status).toBe(401);
  expect(
    await db.first(
      "SELECT user_id FROM google_connections WHERE user_id=?",
      a.userId,
    ),
  ).toBeNull();
});
it("repair is owned by the current user and only resets a failed connection", async () => {
  const a = await registerUser(),
    b = await registerUser(),
    db = testDb(),
    now = new Date().toISOString();
  await db.run(
    "INSERT INTO google_connections(user_id,refresh_enc,spreadsheet_id,status,next_sync_at,updated_at) VALUES (?,?,?,'needs_attention',?,?)",
    a.userId,
    "test-encrypted",
    "missing-sheet",
    now,
    now,
  );
  expect(
    (await api("POST", "/api/google/repair", { cookie: b.cookie })).status,
  ).toBe(409);
  expect(
    (await api("POST", "/api/google/repair", { cookie: a.cookie })).status,
  ).toBe(202);
  const row = await db.first<{ spreadsheet_id: string | null; status: string }>(
    "SELECT spreadsheet_id,status FROM google_connections WHERE user_id=?",
    a.userId,
  );
  expect(row).toEqual({ spreadsheet_id: null, status: "connected" });
});

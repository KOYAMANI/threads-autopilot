import { env } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { handleAction } from "../src/routes/action";
import { actionUrl } from "../src/lib/notify";
import { api, insertAccount, registerUser, testDb } from "./helpers";
import { makeJobContext } from "../src/lib/jobs";
import { planAccount } from "../src/jobs/plan";

const NOW = new Date("2026-09-09T00:00:00.000Z");
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture() {
  const user = await registerUser();
  const accountId = await insertAccount({ userId: user.userId });
  return { ...user, accountId, base: `/api/accounts/${accountId}` };
}
async function queue(accountId: string, status = "scheduled", source = "manual") {
  const id = crypto.randomUUID();
  await testDb().run(`INSERT INTO queue(id,account_id,status,source,scheduled_at,body,created_at,updated_at,approval_mode)
    VALUES (?,?,?,?,?,'公開する本文',?,?,'manual')`, id, accountId, status, source, "2026-09-09T03:00:00.000Z", NOW.toISOString(), NOW.toISOString());
  return id;
}

/** Return the old SELECT snapshot only after another operation has won its DB write. */
function raceAfterRead(matches: (sql: string) => boolean, change: () => Promise<unknown>): D1Database {
  let fired = false;
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, key) {
      if (key === "bind") return (...params: unknown[]) => wrap(target.bind(...params), sql);
      if (key === "first") return async (...args: unknown[]) => {
        const snapshot = await (target.first as (...values: unknown[]) => Promise<unknown>)(...args);
        if (!fired && matches(sql)) { fired = true; await change(); }
        return snapshot;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
async function request(f: Awaited<ReturnType<typeof fixture>>, method: string, path: string, db: D1Database, body?: unknown) {
  return createApp().fetch(new Request(`https://test.local${path}`, {
    method, headers: { Cookie: f.cookie, "X-Requested-With": "fetch", "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), { ...env, DB: db });
}

describe("queue state races", () => {
  it.each(["cancel", "approve", "publish-now", "edit"])("%s cannot overwrite a publish claim after reading scheduled", async (action) => {
    const f = await fixture(); const id = await queue(f.accountId);
    const db = raceAfterRead((s) => s.includes("FROM queue WHERE id=? AND account_id=?"), () => testDb().run("UPDATE queue SET status='publishing' WHERE id=?", id));
    const res = await request(f, action === "edit" ? "PATCH" : "POST", `${f.base}/queue/${id}${action === "edit" ? "" : `/${action}`}`, db, action === "edit" ? { body: "変更した本文" } : undefined);
    expect(res.status).toBe(409);
    expect((await testDb().first<{ status: string; body: string }>("SELECT status,body FROM queue WHERE id=?", id))).toEqual({ status: "publishing", body: "公開する本文" });
    expect(await testDb().first("SELECT id FROM ap_log WHERE ref_id=?", id)).toBeNull();
  });
  it("refuses to delete publishing or partially published rows", async () => {
    const f = await fixture(); const publishing = await queue(f.accountId, "publishing");
    const partial = await queue(f.accountId, "failed");
    await testDb().run(`UPDATE queue SET result_ids_json='["root-already-published"]' WHERE id=?`, partial);
    for (const id of [publishing, partial]) {
      expect((await api("DELETE", `${f.base}/queue/${id}`, { cookie: f.cookie })).status).toBe(409);
      expect(await testDb().first("SELECT id FROM queue WHERE id=?", id)).not.toBeNull();
    }
  });
  it("does not consume the email cancel token or report cancellation after publishing won", async () => {
    const f = await fixture(); const id = await queue(f.accountId, "scheduled", "autopilot");
    const url = await actionUrl(env, { queueId: id, action: "cancel", scheduledAt: "2026-09-09T03:00:00.000Z", nowMs: NOW.getTime() });
    const db = raceAfterRead((s) => s.includes("FROM queue WHERE id=?"), () => testDb().run("UPDATE queue SET status='publishing' WHERE id=?", id));
    const res = await handleAction(new Request(url, { method: "POST" }), { ...env, DB: db });
    const html = await res.text();
    expect(html).not.toContain("<h1>取り消しました</h1>");
    const row = await testDb().first<{ status: string; action_token_used_at: string | null }>("SELECT status,action_token_used_at FROM queue WHERE id=?", id);
    expect(row).toEqual({ status: "publishing", action_token_used_at: null });
  });
  it("changing a manual-approval AP appointment keeps approval pending", async () => {
    const f = await fixture(); const id = await queue(f.accountId, "pending_approval", "autopilot");
    const next = await api("PATCH", `${f.base}/queue/${id}`, { cookie: f.cookie, body: { status: "next_slot" } });
    expect(next.status).toBe(200); expect(next.body.data.item.status).toBe("pending_approval");
    const dated = await api("PATCH", `${f.base}/queue/${id}`, { cookie: f.cookie, body: { status: "scheduled", scheduledAt: "2026-09-09T09:00:00.000Z", reserveSlot: true } });
    expect(dated.status).toBe(200); expect(dated.body.data.item.status).toBe("pending_approval");
    const approved = await api("POST", `${f.base}/queue/${id}/approve`, { cookie: f.cookie });
    expect(approved.status).toBe(200); expect(approved.body.data.item.status).toBe("scheduled");
  });
});

describe("autopilot shutdown", () => {
  it("atomically moves unstarted AP items to drafts and preserves manual / publishing items", async () => {
    const f = await fixture();
    await testDb().run("UPDATE autopilot SET enabled=1 WHERE account_id=?", f.accountId);
    const ap = await queue(f.accountId, "scheduled", "autopilot");
    const pending = await queue(f.accountId, "pending_approval", "autopilot");
    const publishing = await queue(f.accountId, "publishing", "autopilot");
    const manual = await queue(f.accountId);
    const off = await api("PUT", `${f.base}/autopilot`, { cookie: f.cookie, body: { enabled: false } });
    expect(off.status).toBe(200); expect(off.body.data.settings.enabled).toBe(false);
    for (const id of [ap, pending]) expect(await testDb().first("SELECT status,scheduled_at FROM queue WHERE id=?", id)).toEqual({ status: "draft", scheduled_at: null });
    expect((await testDb().first<{ status: string }>("SELECT status FROM queue WHERE id=?", publishing))!.status).toBe("publishing");
    expect((await testDb().first<{ status: string }>("SELECT status FROM queue WHERE id=?", manual))!.status).toBe("scheduled");
  });
  it("a stale settings request cannot turn AP back on after another request turned it off", async () => {
    const f = await fixture();
    await testDb().run("UPDATE autopilot SET enabled=1 WHERE account_id=?", f.accountId);
    const db = raceAfterRead((s) => s.includes("FROM autopilot WHERE account_id=?"), () => testDb().run("UPDATE autopilot SET enabled=0 WHERE account_id=?", f.accountId));
    const res = await request(f, "PUT", `${f.base}/autopilot`, db, { ngWords: "使わない言葉" });
    expect(res.status).toBe(200);
    const data = await res.json() as { data: { settings: { enabled: boolean; ngWords: string } } };
    expect(data.data.settings.enabled).toBe(false); expect(data.data.settings.ngWords).toBe("使わない言葉");
  });
  it("does not enqueue an AI result after AP was turned off during planning", async () => {
    const f = await fixture();
    await api("PUT", "/api/ai/settings", { cookie: f.cookie, body: { provider: "gemini", key: "AIzaTESTKEY0123456789", storeOnServer: true } });
    await api("POST", "/api/sources", { cookie: f.cookie, body: { type: "text", title: "使う参考情報", content: "本文の材料" } });
    await api("PUT", `${f.base}/autopilot`, { cookie: f.cookie, body: { enabled: true, dailyLimit: 1, approvalMode: "auto", linkPlacement: "none" } });
    const db = raceAfterRead((s) => s.includes("FROM sources") && s.includes("enabled_for_ap=1"), () => testDb().run("UPDATE autopilot SET enabled=0 WHERE account_id=?", f.accountId));
    const result = await planAccount(makeJobContext({ ...env, DB: db, AI_MOCK: "1", WORKERS_PLAN: "free" }, { now: NOW }), f.accountId);
    expect(result.planned).toHaveLength(0); expect(result.skipped).toContain("設定が変わった");
    expect(await testDb().first("SELECT id FROM queue WHERE account_id=?", f.accountId)).toBeNull();
    expect((await testDb().first<{ consecutive_failures: number }>("SELECT consecutive_failures FROM autopilot WHERE account_id=?", f.accountId))!.consecutive_failures).toBe(0);
  });
});

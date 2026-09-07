import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localDateKey } from "@tap/shared";
import { api, countRows, insertAccount, registerUser, testDb } from "./helpers";
import { loadAccount } from "../src/lib/accounts";
import { availablePostingSlots } from "../src/lib/posting-schedule";
import { planAccount } from "../src/jobs/plan";
import { preflight } from "../src/jobs/publish";
import { QUEUE_SELECT, type QueueRow } from "../src/lib/queue";
import { makeJobContext } from "../src/lib/jobs";

const NOW = new Date("2026-09-08T00:00:00.000Z"); // Tuesday, 09:00 JST
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

async function fixture() {
  const user = await registerUser();
  const accountId = await insertAccount({ userId: user.userId, timezone: "Asia/Tokyo" });
  return { ...user, accountId, base: `/api/accounts/${accountId}` };
}
async function setTimes(f: Awaited<ReturnType<typeof fixture>>, times = ["10:05", "11:05", "12:05", "13:05"]) {
  return api("PUT", `${f.base}/posting-schedule`, { cookie: f.cookie, body: { times } });
}
async function next(f: Awaited<ReturnType<typeof fixture>>, key = crypto.randomUUID()) {
  return api("POST", `${f.base}/queue`, { cookie: f.cookie, body: { status: "next_slot", body: `予約の本文 ${key}`, idempotencyKey: key } });
}
async function insertManaged(accountId: string, at: string, source = "autopilot") {
  const id = crypto.randomUUID();
  await testDb().run(`INSERT INTO queue (id,account_id,status,scheduled_at,body,source,slot_managed,slot_day,created_at,updated_at)
    VALUES (?,?,'scheduled',?,'予定の本文',?,1,?,?,?)`, id, accountId, at, source, localDateKey(Date.parse(at), "Asia/Tokyo"), NOW.toISOString(), NOW.toISOString());
  return id;
}

describe("posting schedule APIs", () => {
  it("saves minute precision, enforces validation, and isolates accounts", async () => {
    const f = await fixture();
    const other = await fixture();
    expect((await setTimes(f, ["21:45", "09:05"])).body.data).toEqual({ timezone: "Asia/Tokyo", times: ["09:05", "21:45"] });
    expect((await api("GET", `${f.base}/posting-schedule`, { cookie: other.cookie })).status).toBe(404);
    expect((await api("PUT", `${f.base}/posting-schedule`, { cookie: other.cookie, body: { times: ["12:00"] } })).status).toBe(404);
    for (const times of [["09:00", "09:00"], ["24:00"], [], Array.from({ length: 11 }, (_, i) => `${String(i).padStart(2, "0")}:00`)]) {
      expect((await setTimes(f, times)).status).toBe(400);
    }
  });
  it("reserves different slots for simultaneous requests and replays a request only once", async () => {
    const f = await fixture(); await setTimes(f);
    const [a, b] = await Promise.all([next(f), next(f)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.item.scheduledAt).not.toBe(b.body.data.item.scheduledAt);
    const key = crypto.randomUUID();
    const [c, d] = await Promise.all([next(f, key), next(f, key)]);
    expect([200, 201]).toContain(c.status); expect([200, 201]).toContain(d.status);
    expect(c.body.data.item.id).toBe(d.body.data.item.id);
    expect(await countRows("queue", "account_id=?", f.accountId)).toBe(3);
  });
  it("allows four manual posts on one day, then keeps cancelled slots skipped after deletion", async () => {
    const f = await fixture(); await setTimes(f);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await next(f); expect(result.status).toBe(201);
      expect(localDateKey(Date.parse(result.body.data.item.scheduledAt), "Asia/Tokyo")).toBe("2026-09-08");
      ids.push(result.body.data.item.id);
    }
    expect((await api("POST", `${f.base}/queue/${ids[0]}/cancel`, { cookie: f.cookie })).status).toBe(200);
    expect((await api("DELETE", `${f.base}/queue/${ids[0]}`, { cookie: f.cookie })).status).toBe(200);
    const day = await api("GET", `${f.base}/queue/slots?date=2026-09-08`, { cookie: f.cookie });
    expect(day.status).toBe(200); expect(day.body.data.slots[0].skipped).toBe(true);
    expect(day.body.data.slots[0].item).toBeNull();
    const more = await next(f);
    expect(localDateKey(Date.parse(more.body.data.item.scheduledAt), "Asia/Tokyo")).toBe("2026-09-09");
  });
  it("does not move existing appointments after settings changes", async () => {
    const f = await fixture(); await setTimes(f);
    const saved = await next(f); const original = saved.body.data.item;
    await setTimes(f, ["20:30"]);
    const day = await api("GET", `${f.base}/queue/slots?date=2026-09-08`, { cookie: f.cookie });
    expect(day.body.data.slots[0].time).toBe("20:30");
    expect(day.body.data.unslotted[0].id).toBe(original.id);
    expect(day.body.data.unslotted[0].scheduledAt).toBe(original.scheduledAt);
    expect((await api("GET", `${f.base}/queue/slots?date=2026-02-30`, { cookie: f.cookie })).status).toBe(400);
  });
  it("reserves a draft in the next slot and rejects custom writes into reserved slots", async () => {
    const f = await fixture(); await setTimes(f);
    const draft = await api("POST", `${f.base}/queue`, { cookie: f.cookie, body: { status: "draft", body: "下書き" } });
    const scheduled = await api("PATCH", `${f.base}/queue/${draft.body.data.item.id}`, { cookie: f.cookie, body: { status: "next_slot" } });
    expect(scheduled.status).toBe(200); expect(scheduled.body.data.item.scheduledAt).toBe("2026-09-08T01:05:00.000Z");
    const conflict = await api("POST", `${f.base}/queue`, { cookie: f.cookie, body: { status: "scheduled", scheduledAt: scheduled.body.data.item.scheduledAt, body: "別の投稿" } });
    expect(conflict.status).toBe(409);
  });
  it("atomically claims a selected calendar slot and rejects stale schedule selections", async () => {
    const f = await fixture(); await setTimes(f);
    const draft = async () => api("POST", `${f.base}/queue`, { cookie: f.cookie, body: { status: "draft", body: "指定枠の下書き" } });
    const [a, b] = await Promise.all([draft(), draft()]);
    const reserve = (id: string) => api("PATCH", `${f.base}/queue/${id}`, { cookie: f.cookie, body: { status: "scheduled", scheduledAt: "2026-09-08T01:05:00.000Z", reserveSlot: true } });
    const result = await Promise.all([reserve(a.body.data.item.id), reserve(b.body.data.item.id)]);
    expect(result.map((r) => r.status).sort()).toEqual([200, 409]);
    const pending = result[0]!.status === 409 ? a : b;
    await setTimes(f, ["20:00"]);
    const stale = await api("PATCH", `${f.base}/queue/${pending.body.data.item.id}`, { cookie: f.cookie, body: { status: "scheduled", scheduledAt: "2026-09-08T02:05:00.000Z", reserveSlot: true } });
    expect(stale.status).toBe(409);
  });
  it("enforces minimum gap when different nearby slots race", async () => {
    const f = await fixture(); await setTimes(f, ["10:00", "10:05", "11:00"]);
    const make = (at: string) => api("POST", `${f.base}/queue`, { cookie: f.cookie, body: { status: "scheduled", scheduledAt: at, reserveSlot: true, body: `時間 ${at}` } });
    const result = await Promise.all([make("2026-09-08T01:00:00.000Z"), make("2026-09-08T01:05:00.000Z")]);
    expect(result.map((r) => r.status).sort()).toEqual([201, 409]);
  });
  it("still blocks scheduling without a connected Threads account", async () => {
    const f = await fixture();
    await testDb().run("UPDATE accounts SET status='needs_reauth' WHERE id=?", f.accountId);
    expect((await next(f)).status).toBe(409);
    expect(await countRows("queue", "account_id=?", f.accountId)).toBe(0);
  });
});

describe("daily autopilot limits", () => {
  it("atomically caps each day at three autopilot reservations, including cancelled ones", async () => {
    const f = await fixture(); await setTimes(f);
    const ids = await Promise.all(["10:05", "11:05", "12:05"].map((t) => insertManaged(f.accountId, `2026-09-08T${String(Number(t.slice(0, 2)) - 9).padStart(2, "0")}:05:00.000Z`)));
    await testDb().run("DELETE FROM queue WHERE id=?", ids[0]);
    await expect(insertManaged(f.accountId, "2026-09-08T04:05:00.000Z")).rejects.toThrow(/AUTOPILOT_DAILY_LIMIT/);
    const account = (await loadAccount(testDb(), f.accountId))!;
    const open = await availablePostingSlots(testDb(), account, NOW, { autopilotLimit: 3 });
    expect(open.some((s) => s.at.startsWith("2026-09-08T"))).toBe(false);
    // Another local day is independent.
    await expect(insertManaged(f.accountId, "2026-09-09T01:05:00.000Z")).resolves.toBeTypeOf("string");
  });
  it("can move an existing autopilot appointment without counting it as a fourth post", async () => {
    const f = await fixture(); await setTimes(f);
    const ids: string[] = [];
    for (const hour of [1, 2, 3]) ids.push(await insertManaged(f.accountId, `2026-09-08T0${hour}:05:00.000Z`));
    const moved = await api("PATCH", `${f.base}/queue/${ids[0]}`, { cookie: f.cookie, body: { scheduledAt: "2026-09-08T04:05:00.000Z", status: "scheduled", reserveSlot: true } });
    expect(moved.status).toBe(200);
    const day = await api("GET", `${f.base}/queue/slots?date=2026-09-08`, { cookie: f.cookie });
    expect(day.body.data.slots[0].skipped).toBe(true);
    expect(day.body.data.slots[3].item.id).toBe(ids[0]);
    const publishNow = await api("POST", `${f.base}/queue/${ids[0]}/publish-now`, { cookie: f.cookie });
    expect(publishNow.status).toBe(200); // Only schedules a mock queue job; no external publish.
  });
  it("checks the actual publication day again and does not apply AP's three-post cap to manual posts", async () => {
    const f = await fixture();
    await testDb().run("UPDATE autopilot SET daily_limit=3 WHERE account_id=?", f.accountId);
    await testDb().run(`UPDATE accounts SET settings_json='{"minGapMin":0}' WHERE id=?`, f.accountId);
    const account = (await loadAccount(testDb(), f.accountId))!;
    for (let i = 0; i < 3; i++) await testDb().run(`INSERT INTO queue (id,account_id,status,source,body,created_at,updated_at,root_published_at,result_ids_json)
      VALUES (?,?,'done','autopilot','公開済み',?,?,?,'["published-root"]')`, crypto.randomUUID(), f.accountId, NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
    const id = crypto.randomUUID();
    await testDb().run(`INSERT INTO queue (id,account_id,status,source,body,created_at,updated_at)
      VALUES (?,?,'draft','autopilot','別の内容の投稿',?,?)`, id, f.accountId, NOW.toISOString(), NOW.toISOString());
    const row = (await testDb().first<QueueRow>(`SELECT ${QUEUE_SELECT} FROM queue WHERE id=?`, id))!;
    const blocked = await preflight(makeJobContext(env, { now: NOW }), account, row);
    expect(blocked).toEqual({ ok: false, message: "オートパイロットの1日上限（3件）に達しています" });
    const manual = await preflight(makeJobContext(env, { now: NOW }), account, { ...row, source: "manual" });
    expect(manual.ok).toBe(true);
    const nextDay = await preflight(makeJobContext(env, { now: new Date(NOW.getTime() + 86_400_000) }), account, row);
    expect(nextDay.ok).toBe(true);
  });
  it("fills three slots in separate Free jobs, preserves manual approval and stops at the target", async () => {
    const f = await fixture(); await setTimes(f);
    await api("PUT", "/api/ai/settings", { cookie: f.cookie, body: { provider: "gemini", key: "AIzaTESTKEY0123456789", storeOnServer: true } });
    for (let i = 0; i < 5; i++) await api("POST", "/api/sources", { cookie: f.cookie, body: { type: "text", title: `ネタ源${i + 1}`, content: `内容${i + 1}` } });
    const enabled = await api("PUT", `${f.base}/autopilot`, { cookie: f.cookie, body: { enabled: true, dailyLimit: 3, approvalMode: "manual", linkPlacement: "none" } });
    expect(enabled.status).toBe(200);
    const freeEnv = { ...env, WORKERS_PLAN: "free" as const, AI_MOCK: "1" };
    for (let i = 0; i < 3; i++) {
      const ctx = makeJobContext(freeEnv, { now: NOW });
      const result = await planAccount(ctx, f.accountId);
      expect(result.planned).toHaveLength(1);
      expect(ctx.db.queryCount).toBeLessThanOrEqual(32);
    }
    const stopped = await planAccount(makeJobContext(freeEnv, { now: NOW }), f.accountId);
    expect(stopped.planned).toHaveLength(0);
    expect(await countRows("queue", "account_id=? AND status='pending_approval'", f.accountId)).toBe(3);
    expect((await api("PUT", `${f.base}/autopilot`, { cookie: f.cookie, body: { dailyLimit: 4 } })).status).toBe(400);
    await testDb().run("UPDATE queue SET status='done' WHERE account_id=?", f.accountId);
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    vi.setSystemTime(tomorrow);
    const nextDay = await planAccount(makeJobContext(freeEnv, { now: tomorrow }), f.accountId);
    expect(nextDay.planned).toHaveLength(1);
    expect(localDateKey(Date.parse(nextDay.planned[0]!.at), "Asia/Tokyo")).toBe("2026-09-09");
  });
});

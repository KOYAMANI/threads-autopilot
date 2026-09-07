import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertAccount, mockToken, registerUser, testDb } from "./helpers";
import { loadAccount } from "../src/lib/accounts";
import { makeJobContext } from "../src/lib/jobs";
import { preflight, publishJob } from "../src/jobs/publish";
import { QUEUE_SELECT, type QueueRow } from "../src/lib/queue";
import * as threads from "../src/lib/threads";

const NOW = new Date("2026-09-10T12:00:00.000Z");
const free = { ...env, WORKERS_PLAN: "free" as const };
afterEach(() => vi.restoreAllMocks());
async function fixture(limit = 3) {
  const user = await registerUser();
  const accountId = await insertAccount({ userId: user.userId, token: mockToken(crypto.randomUUID()) });
  await testDb().run("UPDATE accounts SET settings_json=? WHERE id=?", JSON.stringify({ minGapMin: 0, commentDelaySec: 1 }), accountId);
  await testDb().run("UPDATE autopilot SET enabled=1,daily_limit=?,link_placement='none' WHERE account_id=?", limit, accountId);
  return { accountId, account: (await loadAccount(testDb(), accountId))! };
}
async function insert(accountId: string, values: { source?: string; status?: string; step?: number; comments?: string[]; image?: string; rootAt?: string; updatedAt?: string } = {}) {
  const id = crypto.randomUUID();
  await testDb().run(`INSERT INTO queue(id,account_id,body,status,source,scheduled_at,comments_json,image_url,step,
    result_ids_json,root_published_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, accountId, `投稿内容 ${crypto.randomUUID()}`, values.status ?? "scheduled", values.source ?? "autopilot", NOW.toISOString(),
    JSON.stringify(values.comments ?? []), values.image ?? null, values.step ?? 0,
    JSON.stringify(values.rootAt ? ["root-" + id] : []), values.rootAt ?? null, NOW.toISOString(), values.updatedAt ?? NOW.toISOString());
  return id;
}
async function row(id: string) { return (await testDb().first<QueueRow>(`SELECT ${QUEUE_SELECT} FROM queue WHERE id=?`, id))!; }
async function tick(accountId: string, now = NOW) {
  const ctx = makeJobContext(free, { now });
  await publishJob(ctx, { id: "test-publish", accountId, type: "publish", attempts: 0, state: {} });
  expect(ctx.db.queryCount).toBeLessThanOrEqual(32);
}

describe("publication safety ledger", () => {
  it("persists the root before replies and keeps a failed thread in the actual day's limit", async () => {
    const f = await fixture(1);
    const id = await insert(f.accountId, { comments: ["[[FAIL]] reply failure"] });
    await tick(f.accountId);
    const root = await row(id);
    expect(root.step).toBe(2);
    expect(root.root_published_at).toBeTruthy();
    expect(JSON.parse(root.result_ids_json)).toHaveLength(1);
    await tick(f.accountId, new Date(NOW.getTime()+2_000));
    expect((await row(id)).status).toBe("failed");
    expect((await row(id)).root_published_at).toBe(root.root_published_at);
    // A later edit or failure timestamp cannot move the publication to another day.
    await testDb().run("UPDATE queue SET updated_at=? WHERE id=?", new Date(NOW.getTime()+86400000).toISOString(), id);
    const next = await insert(f.accountId);
    const create = vi.spyOn(threads, "createTextPost");
    await tick(f.accountId, new Date(NOW.getTime()+60_000));
    expect(create).not.toHaveBeenCalled();
    expect((await row(next)).error).toContain("1日上限（1件）");
    await expect(testDb().run("UPDATE queue SET root_published_at=? WHERE id=?", new Date(NOW.getTime()+86400000).toISOString(), id)).rejects.toThrow("ROOT_PUBLICATION_TIME_IMMUTABLE");
  });

  it("counts done, failed and cancelled public roots equally, while manual posts and tomorrow remain independent", async () => {
    const f = await fixture();
    for (const status of ["done", "failed", "cancelled"]) await insert(f.accountId, { status, rootAt: NOW.toISOString(), updatedAt: new Date(NOW.getTime()-86400000).toISOString() });
    const candidate = await row(await insert(f.accountId, { status: "draft" }));
    expect(await preflight(makeJobContext(free, { now: NOW }), f.account, candidate)).toMatchObject({ ok: false, message: "オートパイロットの1日上限（3件）に達しています" });
    expect((await preflight(makeJobContext(free, { now: NOW }), f.account, { ...candidate, source: "manual" })).ok).toBe(true);
    expect((await preflight(makeJobContext(free, { now: new Date(NOW.getTime()+86400000) }), f.account, candidate)).ok).toBe(true);
  });

  it("uses root publication time for the minimum gap after a reply failure", async () => {
    const f = await fixture();
    await insert(f.accountId, { status: "failed", rootAt: NOW.toISOString(), updatedAt: new Date(NOW.getTime()+86400000).toISOString() });
    const candidate = await row(await insert(f.accountId, { status: "draft" }));
    const account = { ...f.account, settings_json: JSON.stringify({ minGapMin: 30 }) };
    expect(await preflight(makeJobContext(free, { now: new Date(NOW.getTime()+10*60_000) }), account, candidate)).toMatchObject({ ok: false, message: expect.stringContaining("30分あける") });
    expect((await preflight(makeJobContext(free, { now: new Date(NOW.getTime()+60*60_000) }), account, candidate)).ok).toBe(true);
  });

  it("checks limits again before publishing an already-created image container", async () => {
    const f = await fixture();
    const id = await insert(f.accountId, { image: "https://example.com/test.png" });
    await tick(f.accountId);
    expect((await row(id)).step).toBe(1);
    expect((await row(id)).root_published_at).toBeNull();
    for (let i = 0; i < 3; i++) await insert(f.accountId, { status: "failed", rootAt: NOW.toISOString() });
    vi.spyOn(threads, "getContainerStatus").mockResolvedValue({ status: "FINISHED" });
    const publish = vi.spyOn(threads, "publishContainer");
    await tick(f.accountId, new Date(NOW.getTime()+60_000));
    expect(publish).not.toHaveBeenCalled();
    expect((await row(id)).error).toContain("1日上限（3件）");
    expect((await row(id)).root_published_at).toBeNull();
  });

  it("records successful image publication and never moves a root timestamp when later replies finish", async () => {
    const f = await fixture();
    const id = await insert(f.accountId, { image: "https://example.com/test.png", comments: ["reply after midnight"] });
    await tick(f.accountId);
    vi.spyOn(threads, "getContainerStatus").mockResolvedValue({ status: "FINISHED" });
    vi.spyOn(threads, "publishContainer").mockResolvedValue({ id: "image-root" });
    await tick(f.accountId, new Date(NOW.getTime()+60_000));
    const publishedAt = (await row(id)).root_published_at;
    expect(publishedAt).toBeTruthy();
    vi.spyOn(threads, "createTextPost").mockResolvedValue({ id: "image-reply" });
    await tick(f.accountId, new Date(NOW.getTime()+86400000));
    expect((await row(id)).status).toBe("done");
    expect((await row(id)).root_published_at).toBe(publishedAt);
    expect(await testDb().first("SELECT posted_at FROM posts WHERE account_id=? AND id='image-root'", f.accountId)).toEqual({ posted_at: publishedAt });
  });

  it("does not publish a second root if a recovered image row already contains a root ID", async () => {
    const f = await fixture();
    const id = await insert(f.accountId, { status: "publishing", step: 1, rootAt: NOW.toISOString(), image: "https://example.com/test.png" });
    const publish = vi.spyOn(threads, "publishContainer");
    await tick(f.accountId);
    expect(publish).not.toHaveBeenCalled();
    expect((await row(id)).status).toBe("done");
    expect(JSON.parse((await row(id)).result_ids_json)).toHaveLength(1);
  });

  it("checks AP enabled atomically at claim when OFF races a selected scheduled row", async () => {
    const f = await fixture();
    const id = await insert(f.accountId);
    const ctx = makeJobContext(free, { now: NOW });
    const run = ctx.db.run.bind(ctx.db);
    vi.spyOn(ctx.db, "run").mockImplementation(async (sql, ...params) => {
      if (sql.includes("SET status='publishing'")) await testDb().run("UPDATE autopilot SET enabled=0 WHERE account_id=?", f.accountId);
      return run(sql, ...params);
    });
    const create = vi.spyOn(threads, "createTextPost");
    await publishJob(ctx, { id: "race", accountId: f.accountId, type: "publish", attempts: 0, state: {} });
    expect(create).not.toHaveBeenCalled();
    expect((await row(id)).status).toBe("scheduled");
    // An off AP row must not starve an unrelated manual appointment.
    const manual = await insert(f.accountId, { source: "manual" });
    await tick(f.accountId);
    expect((await row(manual)).status).toBe("done");
  });
});

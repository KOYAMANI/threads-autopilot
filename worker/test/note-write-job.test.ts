/**
 * `note_write`（SPEC §8.2）: 1実行＝1章。続きを自分で積み、全章で note が done になる。
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeJobContext, runJobs } from "../src/lib/jobs";
import { noteWriteJob } from "../src/jobs/note-write";
import { api, insertAccount, mockToken, registerUser, testDb } from "./helpers";

// ジョブの next_run_at は実時刻なので、論理時刻は実時刻より先に置く
const NOW = new Date(Date.now() + 60_000);

async function outlinedNote(suffix: string) {
  const before = (env as { AI_MOCK?: string }).AI_MOCK;
  (env as { AI_MOCK?: string }).AI_MOCK = "1";
  try {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken(suffix) });
    await api("PUT", "/api/ai/settings", { cookie: u.cookie, body: { provider: "gemini", key: "AIzaTESTKEY0123456789", storeOnServer: true } });
    const created = await api("POST", "/api/notes", { cookie: u.cookie, body: { accountId, memo: "・ご飯がなんで大切か" } });
    const noteId = created.body.data.note.id as string;
    await api("POST", `/api/notes/${noteId}/outline`, { cookie: u.cookie, body: { assume: true } });
    await api("POST", `/api/notes/${noteId}/write`, { cookie: u.cookie });
    return { ...u, accountId, noteId };
  } finally {
    (env as { AI_MOCK?: string }).AI_MOCK = before;
  }
}

const mockEnv = () => ({ ...env, AI_MOCK: "1" });
const freeEnv = () => ({ ...env, AI_MOCK: "1", WORKERS_PLAN: "free" as const, MAX_DB_QUERIES: "32", MAX_SUBREQUESTS: "20" });

describe("note_write", () => {
  it("1実行で章1つ。続きを force で積み、全章で done にする", async () => {
    const { noteId } = await outlinedNote("j1");
    const db = testDb();
    const chapters = (await db.all("SELECT id FROM note_sections WHERE note_id=?", noteId)).length;
    expect(chapters).toBe(5);

    // free プランは1実行＝ジョブ1件。有料プランは続きを同じ実行で追いかける（下の2つ目の it）
    const first = await runJobs(makeJobContext(freeEnv(), { now: NOW }), { note_write: noteWriteJob });
    expect(first.done).toBe(1);
    let rows = await db.all<{ ord: number; status: string; char_count: number; body: string }>("SELECT ord, status, char_count, body FROM note_sections WHERE note_id=? ORDER BY ord", noteId);
    expect(rows[0]).toMatchObject({ ord: 0, status: "done" });
    expect(rows[0]!.char_count).toBeGreaterThan(1000);
    expect(rows[1]!.status).toBe("todo");
    expect((await db.all("SELECT id FROM jobs WHERE type='note_write' AND status='pending' AND json_extract(state_json,'$.noteId')=?", noteId)).length).toBe(1);
    expect((await db.first<{ status: string }>("SELECT status FROM notes WHERE id=?", noteId))!.status).toBe("writing");

    for (let i = 0; i < 6; i++) await runJobs(makeJobContext(freeEnv(), { now: new Date(NOW.getTime() + (i + 1) * 60_000) }), { note_write: noteWriteJob });
    rows = await db.all("SELECT ord, status, char_count, body FROM note_sections WHERE note_id=? ORDER BY ord", noteId);
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "done", "done", "done"]);
    expect(rows[1]!.body).toContain("## 1-1");
    expect((await db.first<{ status: string }>("SELECT status FROM notes WHERE id=?", noteId))!.status).toBe("done");
    expect((await db.all("SELECT id FROM jobs WHERE type='note_write' AND status='pending' AND json_extract(state_json,'$.noteId')=?", noteId)).length).toBe(0);
  });

  it("有料プランは続きを同じ実行で追いかけ、1回の runJobs で全章を書く", async () => {
    const { noteId } = await outlinedNote("j2");
    const result = await runJobs(makeJobContext(mockEnv(), { now: NOW, timeMs: 60_000 }), { note_write: noteWriteJob });
    expect(result.done).toBe(6);
    expect(result.deferred).toBe(0);
    const rows = await testDb().all<{ status: string }>("SELECT status FROM note_sections WHERE note_id=? ORDER BY ord", noteId);
    expect(rows.every((r) => r.status === "done")).toBe(true);
    expect((await testDb().first<{ status: string }>("SELECT status FROM notes WHERE id=?", noteId))!.status).toBe("done");
  });

  it("やめたら（status が writing でない）何も書かずに終わる", async () => {
    const { noteId } = await outlinedNote("j3");
    await testDb().run("UPDATE notes SET status='outlined' WHERE id=?", noteId);
    await runJobs(makeJobContext(mockEnv(), { now: NOW }), { note_write: noteWriteJob });
    const rows = await testDb().all<{ status: string }>("SELECT status FROM note_sections WHERE note_id=?", noteId);
    expect(rows.every((r) => r.status === "todo")).toBe(true);
    expect((await testDb().all("SELECT id FROM jobs WHERE type='note_write' AND status='pending' AND json_extract(state_json,'$.noteId')=?", noteId)).length).toBe(0);
  });

  it("書き直し: その章だけ todo に戻して書く", async () => {
    const { noteId, cookie } = await outlinedNote("j4");
    const db = testDb();
    for (let i = 0; i < 7; i++) await runJobs(makeJobContext(mockEnv(), { now: new Date(NOW.getTime() + i * 60_000) }), { note_write: noteWriteJob });
    const sec = (await db.first<{ id: string }>("SELECT id FROM note_sections WHERE note_id=? AND ord=2", noteId))!;
    await db.run("UPDATE note_sections SET body='古い本文' WHERE id=?", sec.id);
    const before = (env as { AI_MOCK?: string }).AI_MOCK;
    (env as { AI_MOCK?: string }).AI_MOCK = "1";
    try {
      expect((await api("POST", `/api/notes/${noteId}/sections/${sec.id}/rewrite`, { cookie })).status).toBe(202);
    } finally { (env as { AI_MOCK?: string }).AI_MOCK = before; }
    await runJobs(makeJobContext(mockEnv(), { now: new Date(NOW.getTime() + 10 * 60_000) }), { note_write: noteWriteJob });
    await runJobs(makeJobContext(mockEnv(), { now: new Date(NOW.getTime() + 11 * 60_000) }), { note_write: noteWriteJob });
    const rows = await db.all<{ ord: number; status: string; body: string }>("SELECT ord, status, body FROM note_sections WHERE note_id=? ORDER BY ord", noteId);
    expect(rows[2]!.status).toBe("done");
    expect(rows[2]!.body).not.toBe("古い本文");
    expect(rows.filter((r) => r.ord !== 2).every((r) => r.status === "done")).toBe(true);
    expect((await db.first<{ status: string }>("SELECT status FROM notes WHERE id=?", noteId))!.status).toBe("done");
  });
});

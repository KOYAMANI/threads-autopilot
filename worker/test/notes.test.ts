/**
 * `/api/notes`（SPEC §7.10）。AI は `AI_MOCK=1` の固定応答。
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, insertAccount, mockToken, registerUser, testDb } from "./helpers";

function withAiMock<T>(fn: () => Promise<T>): Promise<T> {
  const before = (env as { AI_MOCK?: string }).AI_MOCK;
  (env as { AI_MOCK?: string }).AI_MOCK = "1";
  return fn().finally(() => { (env as { AI_MOCK?: string }).AI_MOCK = before; });
}

async function setup(suffix: string) {
  const u = await registerUser();
  const accountId = await insertAccount({ userId: u.userId, token: mockToken(suffix) });
  await api("PUT", "/api/ai/settings", { cookie: u.cookie, body: { provider: "gemini", key: "AIzaTESTKEY0123456789", storeOnServer: true } });
  return { ...u, accountId };
}

async function createNote(cookie: string, accountId: string, memo = "・ご飯がなんで大切か\n・基準\n・選び方") {
  const res = await api("POST", "/api/notes", { cookie, body: { accountId, title: "犬のごはん選び", memo } });
  expect(res.status).toBe(201);
  return res.body.data.note as { id: string };
}

describe("/api/notes", () => {
  it("作る → 一覧 → 読む → 直す → 消す。他人からは見えない", async () => {
    const me = await setup("n1");
    const other = await setup("n2");
    const note = await createNote(me.cookie, me.accountId);

    const list = await api("GET", `/api/notes?accountId=${me.accountId}`, { cookie: me.cookie });
    expect(list.status).toBe(200);
    expect(list.body.data.notes.map((n: { id: string }) => n.id)).toEqual([note.id]);
    expect(list.body.data.notes[0].status).toBe("draft");

    const patched = await api("PATCH", `/api/notes/${note.id}`, { cookie: me.cookie, body: { style: "story", volume: "short", refNote: "前回の note", sourceIds: ["x", "x"] } });
    expect(patched.status).toBe(200);
    expect(patched.body.data.note.style).toBe("story");
    expect(patched.body.data.note.sourceIds).toEqual(["x"]);

    expect((await api("GET", `/api/notes/${note.id}`, { cookie: other.cookie })).status).toBe(404);
    expect((await api("PATCH", `/api/notes/${note.id}`, { cookie: other.cookie, body: { memo: "x" } })).status).toBe(404);
    expect((await api("GET", `/api/notes?accountId=${me.accountId}`, { cookie: other.cookie })).status).toBe(404);

    expect((await api("DELETE", `/api/notes/${note.id}`, { cookie: me.cookie })).status).toBe(200);
    expect((await api("GET", `/api/notes/${note.id}`, { cookie: me.cookie })).status).toBe(404);
  });

  it("アカウントを消すと note と章も消える（FK の CASCADE。削除の文数を増やさない）", async () => {
    const me = await setup("n8");
    const note = await createNote(me.cookie, me.accountId);
    const db = testDb();
    await db.run("INSERT INTO note_sections (id, note_id, ord, heading, target_chars, updated_at) VALUES (?,?,0,'はじめに',1000,?)", crypto.randomUUID(), note.id, new Date().toISOString());
    expect((await api("DELETE", `/api/accounts/${me.accountId}`, { cookie: me.cookie })).status).toBe(200);
    expect((await db.all("SELECT id FROM notes WHERE id=?", note.id)).length).toBe(0);
    expect((await db.all("SELECT id FROM note_sections WHERE note_id=?", note.id)).length).toBe(0);
  });

  it("本文の無い YouTube 資料は、目次の前に要点を書き出して保存し、章でも使う", async () => {
    await withAiMock(async () => {
      const me = await setup("nv");
      const now = new Date().toISOString();
      await testDb().run("INSERT INTO sources (id, user_id, type, title, url, content, created_at) VALUES ('src-v', ?, 'youtube', 'フードの見抜き方', 'https://www.youtube.com/watch?v=abc', '', ?)", me.userId, now);
      const note = await createNote(me.cookie, me.accountId);
      await api("PATCH", `/api/notes/${note.id}`, { cookie: me.cookie, body: { sourceIds: ["src-v"] } });
      const res = await api("POST", `/api/notes/${note.id}/outline`, { cookie: me.cookie, body: { assume: true } });
      expect(res.status).toBe(200);
      const row = await testDb().first<{ source_digest_json: string }>("SELECT source_digest_json FROM notes WHERE id=?", note.id);
      expect(JSON.parse(row!.source_digest_json)["src-v"]).toContain("フードの見抜き方");
    });
  });

  it("目次: 質問に答えながら進み、3回で必ず目次になる", async () => {
    await withAiMock(async () => {
      const me = await setup("n3");
      const note = await createNote(me.cookie, me.accountId, "質問テスト\n・ご飯がなんで大切か");

      const q1 = await api("POST", `/api/notes/${note.id}/outline`, { cookie: me.cookie, body: {} });
      expect(q1.status).toBe(200);
      expect(q1.body.data).toMatchObject({ status: "question", round: 1 });

      const q2 = await api("POST", `/api/notes/${note.id}/outline`, { cookie: me.cookie, body: { answer: "飼っている人" } });
      expect(q2.body.data).toMatchObject({ status: "question", round: 2 });
      const q3 = await api("POST", `/api/notes/${note.id}/outline`, { cookie: me.cookie, body: { answer: "入れない" } });
      expect(q3.body.data).toMatchObject({ status: "question", round: 3 });

      // 4回目は答えが無くても assume で目次になる
      const done = await api("POST", `/api/notes/${note.id}/outline`, { cookie: me.cookie, body: {} });
      expect(done.status).toBe(200);
      expect(done.body.data.status).toBe("ok");
      const n = done.body.data.note;
      expect(n.status).toBe("outlined");
      expect(n.outline.chapters.length).toBe(5);
      expect(n.titleOptions.length).toBe(3);
      expect(n.title).toBe(n.titleOptions[0]);
      expect(n.paywallAfter).toBe(1);
      expect(n.qa.length).toBe(3);
      expect(n.qa[2].answer).toBe("");
    });
  });

  it("目次: お任せ（assume）なら質問を飛ばす。memo が空なら 400", async () => {
    await withAiMock(async () => {
      const me = await setup("n4");
      const note = await createNote(me.cookie, me.accountId, "質問テスト");
      const res = await api("POST", `/api/notes/${note.id}/outline`, { cookie: me.cookie, body: { assume: true } });
      expect(res.body.data.status).toBe("ok");
      const empty = await createNote(me.cookie, me.accountId, "");
      expect((await api("POST", `/api/notes/${empty.id}/outline`, { cookie: me.cookie, body: {} })).status).toBe(400);
    });
  });

  it("目次の編集: 有料ラインは章数に収め、書いている途中は 409", async () => {
    await withAiMock(async () => {
      const me = await setup("n5");
      const note = await createNote(me.cookie, me.accountId);
      await api("POST", `/api/notes/${note.id}/outline`, { cookie: me.cookie, body: {} });
      const outline = { chapters: [
        { heading: "はじめに", targetChars: 1000, sections: [] },
        { heading: "第1章 なぜ", targetChars: 2000, sections: [{ title: "1-1 毎日", caution: "注意" }] },
        { heading: "まとめ", targetChars: 600, sections: [] },
      ] };
      const res = await api("PATCH", `/api/notes/${note.id}`, { cookie: me.cookie, body: { outline, paywallAfter: 5 } });
      expect(res.status).toBe(200);
      expect(res.body.data.note.outline.chapters[1].sections[0]).toEqual({ title: "1-1 毎日", caution: "注意" });
      expect(res.body.data.note.paywallAfter).toBe(1);

      const started = await api("POST", `/api/notes/${note.id}/write`, { cookie: me.cookie });
      expect(started.status).toBe(202);
      expect(started.body.data.note.status).toBe("writing");
      expect(started.body.data.note.sections.map((s: { ord: number; status: string }) => [s.ord, s.status])).toEqual([[0, "todo"], [1, "todo"], [2, "todo"]]);
      expect((await api("PATCH", `/api/notes/${note.id}`, { cookie: me.cookie, body: { memo: "x" } })).status).toBe(409);
      expect((await api("POST", `/api/notes/${note.id}/write`, { cookie: me.cookie })).status).toBe(409);

      const jobs = await testDb().all<{ type: string; status: string; state_json: string }>("SELECT type, status, state_json FROM jobs WHERE type='note_write' AND json_extract(state_json,'$.noteId')=?", note.id);
      expect(jobs.length).toBe(1);
      expect(JSON.parse(jobs[0]!.state_json).noteId).toBe(note.id);

      const cancelled = await api("POST", `/api/notes/${note.id}/cancel`, { cookie: me.cookie });
      expect(cancelled.body.data.note.status).toBe("outlined");
      // 続きから: 書けた章は残す
      await testDb().run("UPDATE note_sections SET status='done', body='b', char_count=1 WHERE note_id=? AND ord=0", note.id);
      const resumed = await api("POST", `/api/notes/${note.id}/write`, { cookie: me.cookie, body: { resume: true } });
      expect(resumed.status).toBe(202);
      expect(resumed.body.data.note.sections.map((s: { status: string }) => s.status)).toEqual(["done", "todo", "todo"]);
      await api("POST", `/api/notes/${note.id}/cancel`, { cookie: me.cookie });
      expect((await testDb().all("SELECT id FROM jobs WHERE type='note_write' AND status='pending' AND json_extract(state_json,'$.noteId')=?", note.id)).length).toBe(0);
    });
  });

  it("書く前に目次が無ければ 400、AI キーが無ければ 400（AI_KEY_REQUIRED）", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken("n6") });
    const note = await createNote(u.cookie, accountId);
    expect((await api("POST", `/api/notes/${note.id}/write`, { cookie: u.cookie })).status).toBe(400);
    const res = await api("POST", `/api/notes/${note.id}/outline`, { cookie: u.cookie, body: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("AI_KEY_REQUIRED");
  });

  it("章を指示で直す: done の章だけ。書き直しはジョブを積む", async () => {
    await withAiMock(async () => {
      const me = await setup("n7");
      const note = await createNote(me.cookie, me.accountId);
      await api("POST", `/api/notes/${note.id}/outline`, { cookie: me.cookie, body: {} });
      await api("POST", `/api/notes/${note.id}/write`, { cookie: me.cookie });
      const db = testDb();
      const sec = (await db.first<{ id: string }>("SELECT id FROM note_sections WHERE note_id=? AND ord=1", note.id))!;
      expect((await api("POST", `/api/notes/${note.id}/sections/${sec.id}/revise`, { cookie: me.cookie, body: { instruction: "短く" } })).status).toBe(409);
      await db.run("UPDATE note_sections SET status='done', body='本文', summary='要約', char_count=2 WHERE id=?", sec.id);
      await db.run("UPDATE notes SET status='done' WHERE id=?", note.id);
      const revised = await api("POST", `/api/notes/${note.id}/sections/${sec.id}/revise`, { cookie: me.cookie, body: { instruction: "短く" } });
      expect(revised.status).toBe(200);
      expect(revised.body.data.section.body).toContain("短くを反映しました");

      await db.run("DELETE FROM jobs WHERE type='note_write'");
      const rewrite = await api("POST", `/api/notes/${note.id}/sections/${sec.id}/rewrite`, { cookie: me.cookie });
      expect(rewrite.status).toBe(202);
      expect(rewrite.body.data.note.status).toBe("writing");
      expect(rewrite.body.data.note.sections[1].status).toBe("todo");
      expect((await db.all("SELECT id FROM jobs WHERE type='note_write' AND status='pending' AND json_extract(state_json,'$.noteId')=?", note.id)).length).toBe(1);
    });
  });
});

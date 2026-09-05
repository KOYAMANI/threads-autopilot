import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { enqueueJob, makeJobContext, runJobs } from "../src/lib/jobs";
import { fullSyncJob, SYNC_TOTAL_PAGES } from "../src/jobs/sync";
import { resetMock } from "../src/mock/threads";
import { insertAccount, mockToken, registerUser, testDb } from "./helpers";

const NOW = new Date("2026-09-06T00:00:00.000Z");

beforeEach(() => {
  resetMock();
});

async function setup(suffix: string) {
  const u = await registerUser();
  const accountId = await insertAccount({ userId: u.userId, token: mockToken(suffix) });
  return { u, accountId };
}

describe("full_sync（SPEC §8.4）", () => {
  it("モックの投稿と自分の返信が posts に入り、タグが付く", async () => {
    const { accountId } = await setup("sync1");
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "full_sync", { accountId });
    const res = await runJobs(ctx);
    expect(res.failed).toBe(0);

    const db = testDb();
    const roots = await db.all<{ id: string; tags_json: string; source: string }>(
      "SELECT id, tags_json, source FROM posts WHERE account_id=? AND is_reply=0",
      accountId,
    );
    const replies = await db.all<{ id: string; root_id: string }>(
      "SELECT id, root_id FROM posts WHERE account_id=? AND is_reply=1",
      accountId,
    );
    expect(roots.length).toBe(10);
    expect(replies.length).toBe(4);
    // 返信は自分の root にぶら下がる
    const rootIds = new Set(roots.map((r) => r.id));
    for (const r of replies) expect(rootIds.has(r.root_id)).toBe(true);

    // 外部投稿にも §9.1 のタグが付く
    const tags = JSON.parse(roots[0]!.tags_json) as Record<string, string>;
    expect(tags.hook).toBeTruthy();
    expect(tags.length).toBeTruthy();
    expect(tags.daytype).toMatch(/weekday|weekend/);
    expect(roots[0]!.source).toBe("external");

    // last_full_sync_at が入る
    const a = await db.first<{ last_full_sync_at: string | null }>(
      "SELECT last_full_sync_at FROM accounts WHERE id=?",
      accountId,
    );
    expect(a?.last_full_sync_at).toBe(NOW.toISOString());
  });

  it("本文のURLが links に自動追加される（SPEC §7.5）", async () => {
    const { accountId } = await setup("sync2");
    const ctx = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx, "full_sync", { accountId });
    await runJobs(ctx);

    const links = await testDb().all<{ url: string; label: string; kind: string }>(
      "SELECT url, label, kind FROM links WHERE account_id=? ORDER BY url",
      accountId,
    );
    const urls = links.map((l) => l.url);
    expect(urls).toContain("https://lin.ee/threadsdemo");
    // utm_source が落ちた正規化URLで入る
    expect(urls).toContain("https://example.com/sheet");
    expect(links[0]!.label).toBe(links[0]!.url);
    expect(links[0]!.kind).toBe("other");
  });

  it("2回流しても行が増えず、数字は保持される（upsert）", async () => {
    const { accountId } = await setup("sync3");
    const db = testDb();

    const ctx1 = makeJobContext(env, { now: NOW });
    await enqueueJob(ctx1, "full_sync", { accountId });
    await runJobs(ctx1);
    const before = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM posts WHERE account_id=?",
      accountId,
    );

    // 数字と採点済みタグを入れておく
    const target = (await db.first<{ id: string }>(
      "SELECT id FROM posts WHERE account_id=? AND is_reply=0 LIMIT 1",
      accountId,
    ))!;
    await db.run(
      "UPDATE posts SET views=1234, likes=56, clicks=7.5, tags_json='{\"hook\":\"警告型\",\"scored\":true}' WHERE account_id=? AND id=?",
      accountId,
      target.id,
    );

    const ctx2 = makeJobContext(env, { now: new Date(NOW.getTime() + 3600_000) });
    await enqueueJob(ctx2, "full_sync", { accountId, force: true });
    await runJobs(ctx2);

    const after = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM posts WHERE account_id=?",
      accountId,
    );
    expect(after?.n).toBe(before?.n);

    const row = await db.first<{ views: number; clicks: number; tags_json: string }>(
      "SELECT views, clicks, tags_json FROM posts WHERE account_id=? AND id=?",
      accountId,
      target.id,
    );
    expect(row?.views).toBe(1234);
    expect(row?.clicks).toBe(7.5);
    // 採点済みタグは潰さない
    expect(JSON.parse(row!.tags_json)).toEqual({ hook: "警告型", scored: true });
  });

  it("D1 クエリ予算が尽きても、次回の実行で完了する（SPEC §8.1 の再開）", async () => {
    const { accountId } = await setup("sync4");
    const db = testDb();

    // 予算をわざと小さくして途中で落とす
    const tight = makeJobContext(env, { now: NOW, dbQueries: 5 });
    const jobId = (await enqueueJob(tight, "full_sync", { accountId }))!;
    const res1 = await runJobs(tight);
    expect(res1.deferred).toBe(1);
    expect(res1.exhausted).toBe(true);

    const mid = await db.first<{ status: string }>("SELECT status FROM jobs WHERE id=?", jobId);
    expect(mid?.status).toBe("pending");

    // 次の実行（予算そのまま）で完走する
    const full = makeJobContext(env, { now: NOW });
    const res2 = await runJobs(full);
    expect(res2.done).toBeGreaterThanOrEqual(1);
    const after = await db.first<{ status: string; state_json: string }>(
      "SELECT status, state_json FROM jobs WHERE id=?",
      jobId,
    );
    expect(after?.status).toBe("done");
    expect(JSON.parse(after!.state_json).pages).toBe(SYNC_TOTAL_PAGES);

    const n = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM posts WHERE account_id=?",
      accountId,
    );
    expect(n?.n).toBe(14);
  });

  it("外部fetch予算が尽きても次回続きから完了する", async () => {
    const { accountId } = await setup("sync5");
    const tight = makeJobContext(env, { now: NOW, subrequests: 1 });
    const jobId = (await enqueueJob(tight, "full_sync", { accountId }))!;
    await runJobs(tight);
    expect(
      (await testDb().first<{ status: string }>("SELECT status FROM jobs WHERE id=?", jobId))
        ?.status,
    ).toBe("pending");

    await runJobs(makeJobContext(env, { now: NOW }));
    const after = await testDb().first<{ status: string }>(
      "SELECT status FROM jobs WHERE id=?",
      jobId,
    );
    expect(after?.status).toBe("done");
    const n = await testDb().first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM posts WHERE account_id=?",
      accountId,
    );
    expect(n?.n).toBe(14);
  });

  it("needs_reauth のアカウントは同期しない", async () => {
    const u = await registerUser();
    const accountId = await insertAccount({
      userId: u.userId,
      token: mockToken("sync6"),
      status: "needs_reauth",
    });
    const ctx = makeJobContext(env, { now: NOW });
    await fullSyncJob(ctx, {
      id: "x",
      type: "full_sync",
      accountId,
      attempts: 0,
      state: {},
    });
    const n = await testDb().first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM posts WHERE account_id=?",
      accountId,
    );
    expect(n?.n).toBe(0);
  });
});

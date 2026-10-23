import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createApp } from "../src/app";
import { enqueueForCron, makeJobContext } from "../src/lib/jobs";
import { publishJob } from "../src/jobs/publish";
import { insertAccount, mockToken, registerUser, testDb } from "./helpers";

const NOW = new Date("2026-10-23T00:00:00.000Z");
// 本番とステージングと同じく AUTOPILOT_RUNNING を設定しない
const paused = (): Env => ({ ...env, AUTOPILOT_RUNNING: undefined });
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const user = await registerUser();
  const accountId = await insertAccount({ userId: user.userId, token: mockToken(crypto.randomUUID()) });
  await testDb().run("UPDATE autopilot SET enabled=1 WHERE account_id=?", accountId);
  return { user, accountId };
}

describe("オートパイロットの停止（DECISIONS 2026-10-23）", () => {
  it("毎時・日次の cron は ap_plan / ap_notify / ap_score を積まない", async () => {
    const { accountId } = await fixture();
    const ctx = makeJobContext(paused(), { now: NOW });
    await enqueueForCron(ctx, "0 * * * *");
    await enqueueForCron(ctx, "0 18 * * *");
    const rows = await testDb().all<{ type: string }>("SELECT type FROM jobs WHERE account_id=?", accountId);
    expect(rows.map((r) => r.type)).toContain("insights_recent");
    expect(rows.filter((r) => r.type.startsWith("ap_"))).toEqual([]);
  });

  it("オンのままのアカウントでも、自動作成の予約は投稿しない", async () => {
    const { accountId } = await fixture();
    const id = crypto.randomUUID();
    await testDb().run(
      `INSERT INTO queue(id,account_id,body,status,source,scheduled_at,comments_json,created_at,updated_at)
        VALUES (?,?,?,'scheduled','autopilot',?,'[]',?,?)`,
      id, accountId, "自動で作られた投稿です。", NOW.toISOString(), NOW.toISOString(), NOW.toISOString(),
    );
    await publishJob(makeJobContext(paused(), { now: NOW }), { id: "p", type: "publish", accountId, attempts: 0, state: {} });
    expect(await testDb().first("SELECT status, result_ids_json FROM queue WHERE id=?", id))
      .toEqual({ status: "scheduled", result_ids_json: "[]" });
  });

  it("オンにする API は断る", async () => {
    const { user, accountId } = await fixture();
    const res = await createApp().fetch(new Request(`https://test.local/api/accounts/${accountId}/autopilot`, {
      method: "PUT",
      headers: { Cookie: user.cookie, "Content-Type": "application/json", "X-Requested-With": "fetch" },
      body: JSON.stringify({ enabled: true }),
    }), paused());
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("自動作成は停止中です");
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { makeJobContext } from "../src/lib/jobs";
import { MAX_CONTAINER_POLLS, publishJob } from "../src/jobs/publish";
import { resetMock } from "../src/mock/threads";
import worker from "../src/index";
import { insertAccount, mockToken, registerUser, testDb } from "./helpers";

// 画像つき投稿（DECISIONS 2026-10-30）: 1枚は IMAGE、2枚以上はカルーセル、コメントにも付けられる
const NOW = new Date("2026-09-10T12:00:00.000Z");
const img = (n: number) => ({ url: `https://example.com/p${n}.jpg`, alt: `写真${n}` });

beforeEach(() => resetMock());

async function setup(suffix: string, twoStep = false) {
  const u = await registerUser();
  const accountId = await insertAccount({ userId: u.userId, token: mockToken(suffix) });
  return { accountId, e: { ...env, REPLY_TWO_STEP: twoStep ? "1" : "0" } as typeof env };
}

async function insertQueue(accountId: string, body: string, comments: string[], media: unknown[][]): Promise<string> {
  const id = crypto.randomUUID();
  await testDb().run(
    `INSERT INTO queue (id, account_id, status, scheduled_at, body, comments_json, media_json, source, created_at, updated_at)
      VALUES (?,?,'scheduled',?,?,?,?,'manual',?,?)`,
    id, accountId, NOW.toISOString(), body, JSON.stringify(comments), JSON.stringify(media), NOW.toISOString(), NOW.toISOString(),
  );
  return id;
}

const readQueue = (id: string) =>
  testDb().first<{ status: string; next_step_at: string | null; result_ids_json: string; error: string | null; container_polls: number; media_state_json: string | null }>(
    "SELECT status, next_step_at, result_ids_json, error, container_polls, media_state_json FROM queue WHERE id=?", id);

async function drain(e: typeof env, accountId: string, queueId: string, max = 30) {
  let now = NOW;
  for (let i = 0; i < max; i++) {
    await publishJob(makeJobContext(e, { now }), { id: "job", type: "publish", accountId, attempts: 0, state: {} });
    const row = (await readQueue(queueId))!;
    if (row.status !== "scheduled" && row.status !== "publishing") break;
    now = new Date(Math.max(row.next_step_at ? Date.parse(row.next_step_at) : 0, now.getTime() + 1000));
  }
  return (await readQueue(queueId))!;
}

async function postsOf(accountId: string, ids: string[]) {
  const out: { media_type: string; media_url: string | null; text: string }[] = [];
  for (const id of ids) {
    out.push((await testDb().first<{ media_type: string; media_url: string | null; text: string }>(
      "SELECT media_type, media_url, text FROM posts WHERE account_id=? AND id=?", accountId, id))!);
  }
  return out;
}

describe("画像つきの publish", () => {
  for (const twoStep of [false, true]) {
    it(`1投稿目のカルーセルとコメントの画像が出る（REPLY_TWO_STEP=${twoStep ? 1 : 0}）`, async () => {
      const { accountId, e } = await setup(`med${twoStep ? 2 : 1}`, twoStep);
      const qid = await insertQueue(accountId, "朝のルーティン", ["文字だけのコメント", ""], [[img(1), img(2), img(3)], [], [img(4)]]);

      const row = await drain(e, accountId, qid);

      expect(row.status).toBe("done");
      expect(row.media_state_json).toBeNull();
      const ids = JSON.parse(row.result_ids_json) as string[];
      expect(await postsOf(accountId, ids)).toEqual([
        { media_type: "CAROUSEL_ALBUM", media_url: img(1).url, text: "朝のルーティン" },
        { media_type: "TEXT_POST", media_url: null, text: "文字だけのコメント" },
        { media_type: "IMAGE", media_url: img(4).url, text: "" },
      ]);
    });
  }

  it("本文が空でも画像があれば出せる", async () => {
    const { accountId, e } = await setup("med3");
    const qid = await insertQueue(accountId, "", [], [[img(1)]]);
    const row = await drain(e, accountId, qid);
    expect(row.status).toBe("done");
    expect((await postsOf(accountId, JSON.parse(row.result_ids_json)))[0]!.media_type).toBe("IMAGE");
  });

  it("カルーセルの子が ERROR なら1投稿目を出さずに failed になる", async () => {
    const { accountId, e } = await setup("med4");
    const qid = await insertQueue(accountId, "壊れた画像", [], [[img(1), { url: "https://example.com/broken.jpg" }]]);
    const row = await drain(e, accountId, qid);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("1投稿目の画像を Threads が読み込めませんでした");
    expect(JSON.parse(row.result_ids_json)).toEqual([]);
  });

  it("コメントの画像が終わらなければ、出した1投稿目を残して failed になる", async () => {
    const { accountId, e } = await setup("med5");
    const qid = await insertQueue(accountId, "本文", ["続き"], [[], [{ url: "https://example.com/slow.jpg" }]]);
    const row = await drain(e, accountId, qid, MAX_CONTAINER_POLLS + 10);
    expect(row.status).toBe("failed");
    expect(row.container_polls).toBe(MAX_CONTAINER_POLLS);
    expect(JSON.parse(row.result_ids_json)).toHaveLength(1);
  });
});

describe("画像の API", () => {
  // /m/ は Hono の外（index.ts）なので、Worker の入口から呼ぶ
  const SELF = {
    fetch: (url: string, init?: RequestInit) =>
      worker.fetch(new Request(url, init), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext),
  };
  async function login() {
    const u = await registerUser();
    const accountId = await insertAccount({ userId: u.userId, token: mockToken(`api${Math.random().toString(36).slice(2, 6)}`) });
    const headers = { Cookie: u.cookie, "X-Requested-With": "fetch" };
    return { accountId, headers };
  }
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

  it("アップロードした画像を /m/ で配る", async () => {
    const { accountId, headers } = await login();
    const res = await SELF.fetch(`https://app.test/api/accounts/${accountId}/media`, {
      method: "POST", headers: { ...headers, "Content-Type": "image/jpeg" }, body: jpeg,
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { url: string } };
    const key = data.url.split("/m/")[1]!;
    expect(key).toMatch(/^[0-9a-f-]{36}\.jpg$/);

    const served = await SELF.fetch(`https://app.test/m/${key}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(jpeg);
  });

  it("画像でないものや大きすぎるものは受け取らない", async () => {
    const { accountId, headers } = await login();
    const url = `https://app.test/api/accounts/${accountId}/media`;
    const text = await SELF.fetch(url, { method: "POST", headers, body: "hello" });
    expect(text.status).toBe(415);
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    big.set(jpeg);
    const tooBig = await SELF.fetch(url, { method: "POST", headers, body: big });
    expect(tooBig.status).toBe(413);
    expect((await SELF.fetch("https://app.test/m/../secret")).status).toBe(404);
  });

  it("予約に media を保存し、空のコメントでも画像があれば残す。11枚は断る", async () => {
    const { accountId, headers } = await login();
    const url = `https://app.test/api/accounts/${accountId}/queue`;
    const post = (body: unknown) => SELF.fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });

    const created = await post({ status: "draft", body: "本文", comments: ["", "", "続き"], media: [[img(1)], [img(2)], [], []] });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { item: { comments: string[]; media: unknown[][]; imageUrl: string } } };
    expect(data.item.comments).toEqual(["", "続き"]);
    expect(data.item.media).toEqual([[img(1)], [img(2)]]);
    expect(data.item.imageUrl).toBe(img(1).url);

    const tooMany = await post({ status: "draft", body: "本文", media: [Array.from({ length: 11 }, (_, i) => img(i))] });
    expect(tooMany.status).toBe(400);
    expect(((await tooMany.json()) as { error: { message: string } }).error.message).toContain("10枚まで");

    const legacy = await post({ status: "draft", body: "本文", imageUrl: "https://example.com/old.png" });
    expect(((await legacy.json()) as { data: { item: { media: unknown[][] } } }).data.item.media).toEqual([[{ url: "https://example.com/old.png" }]]);
  });
});

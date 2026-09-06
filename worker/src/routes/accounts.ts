/**
 * アカウント（SPEC §7.1）。
 * すべて `accounts.user_id` が本人かを確かめてから触る。
 */
import { Hono } from "hono";
import { z } from "zod";
import { ok, type ConnectAccountResponse, type DiagnoseStep } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import {
  ACCOUNT_COLORS,
  ACCOUNT_COLUMNS,
  ACCOUNT_LIMIT,
  accountToken,
  deleteAccountData,
  loadOwnedAccount,
  toAccountSummary,
  tokenExpiresInDays,
  type AccountRow,
} from "../lib/accounts";
import { encrypt } from "../lib/crypto";
import { enqueueJob, jobContextFrom } from "../lib/jobs";
import { refreshAccountToken, remainingDays } from "../jobs/maintenance";
import { SYNC_TOTAL_PAGES } from "../jobs/sync";
import {
  exchangeToken,
  getDailyViews,
  getLinkClicks,
  getPostInsights,
  getProfile,
  listThreads,
  threadsReason,
  ThreadsApiError,
  type CallOptions,
} from "../lib/threads";
import { unixSec } from "../lib/time";

const connectSchema = z.object({
  token: z.string().trim().min(10).max(1000),
  app_secret: z.string().trim().min(1).max(200).optional(),
});

const patchSchema = z.object({
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** IANA の timezone として通るか（`Asia/Tokyo` 等）。 */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function accountRoutes() {
  const r = new Hono<AppEnv>();

  /* ── 一覧 ────────────────────────────────────────── */
  r.get("/", async (c) => {
    const db = c.get("db");
    const rows = await db.all<AccountRow & { ap_enabled: number | null }>(
      `SELECT ${ACCOUNT_COLUMNS.split(", ")
        .map((x) => `a.${x}`)
        .join(", ")}, ap.enabled AS ap_enabled
         FROM accounts a LEFT JOIN autopilot ap ON ap.account_id=a.id
        WHERE a.user_id=? ORDER BY a.created_at ASC`,
      c.get("userId")!,
    );
    const nowMs = Date.now();
    return c.json(
      ok({
        accounts: rows.map((a) =>
          toAccountSummary(a, { autopilotEnabled: Boolean(a.ap_enabled), nowMs }),
        ),
      }),
    );
  });

  /* ── 接続（SPEC §7.1 / §6.3） ─────────────────────── */
  r.post("/", async (c) => {
    const parsed = connectSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      return fail("BAD_REQUEST", "トークンを貼り付けてください", 400);
    }
    const { token, app_secret: appSecret } = parsed.data;
    const db = c.get("db");
    const userId = c.get("userId")!;
    const now = new Date();
    const options: CallOptions = { budget: c.get("budget"), env: c.env };

    // 接続確認
    const profile = await getProfile(token, options);
    if (!profile?.id) {
      return fail("THREADS_ERROR", "Threadsのアカウント情報を取得できませんでした", 502);
    }

    const existing = await db.first<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE user_id=? AND threads_user_id=?`,
      userId,
      profile.id,
    );

    if (!existing) {
      const countRow = await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM accounts WHERE user_id=?",
        userId,
      );
      if ((countRow?.n ?? 0) >= ACCOUNT_LIMIT) {
        return fail(
          "ACCOUNT_LIMIT",
          `つなげるアカウントは${ACCOUNT_LIMIT}つまでです。設定から1つ外してください`,
          400,
        );
      }
    }

    // 長期化（App Secret は保存しない。SPEC §6.3）
    let finalToken = token;
    let longLived = false;
    let secretIgnored = false;
    if (appSecret) {
      try {
        const res = await exchangeToken(token, appSecret, options);
        if (res?.access_token) {
          finalToken = res.access_token;
          longLived = true;
        } else {
          secretIgnored = true;
        }
      } catch {
        // 長期化に失敗しても接続自体は成立する。短期のまま保存し、画面に知らせる
        secretIgnored = true;
      }
    }

    const nowIso = now.toISOString();
    const tokenEnc = await encrypt(finalToken, c.env.ENC_KEY);
    let accountId: string;

    if (existing) {
      accountId = existing.id;
      await db.run(
        `UPDATE accounts SET username=?, name=?, avatar_url=?, token_enc=?, token_obtained_at=?,
             token_long_lived=?, token_last_refresh_at=NULL, status='ok'
           WHERE id=?`,
        profile.username ?? existing.username,
        profile.name ?? null,
        profile.threads_profile_picture_url ?? null,
        tokenEnc,
        nowIso,
        longLived ? 1 : 0,
        accountId,
      );
    } else {
      accountId = crypto.randomUUID();
      const usedColors = await db.all<{ color: string }>(
        "SELECT color FROM accounts WHERE user_id=?",
        userId,
      );
      // 色の比較は**大文字小文字を無視する**。`#2748E8` と `#2748e8` は同じ色なのに、
      // 素の一致だと「使っていない色」と判定されて、見分けの付かない2つ目の青が出る
      const used = new Set(usedColors.map((u) => u.color.trim().toLowerCase()));
      const color =
        ACCOUNT_COLORS.find((x) => !used.has(x.toLowerCase())) ?? ACCOUNT_COLORS[0]!;
      await db.run(
        `INSERT INTO accounts (id, user_id, threads_user_id, username, name, avatar_url, color,
             token_enc, token_obtained_at, token_long_lived, token_last_refresh_at, status,
             timezone, settings_json, last_full_sync_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'ok',?, '{}', NULL, ?)`,
        accountId,
        userId,
        profile.id,
        profile.username ?? profile.id,
        profile.name ?? null,
        profile.threads_profile_picture_url ?? null,
        color,
        tokenEnc,
        nowIso,
        longLived ? 1 : 0,
        c.env.DEFAULT_TZ || "Asia/Tokyo",
        nowIso,
      );
      await db.run(
        `INSERT INTO autopilot (account_id, updated_at) VALUES (?,?)
           ON CONFLICT(account_id) DO NOTHING`,
        accountId,
        nowIso,
      );
    }

    // 接続直後に full_sync（SPEC §7.1）
    const jobCtx = jobContextFrom(c.env, db, c.get("budget"), now);
    await enqueueJob(jobCtx, "full_sync", { accountId });

    const saved = (await db.first<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id=?`,
      accountId,
    ))!;
    const body: ConnectAccountResponse = {
      account: toAccountSummary(saved, { nowMs: now.getTime() }),
      longLived,
      secretIgnored,
    };
    return c.json(ok(body), existing ? 200 : 201);
  });

  /* ── 削除（関連データを全部消す。SPEC §7.1） ───────── */
  r.delete("/:id", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    await deleteAccountData(db, account.id);
    await db.run(
      "INSERT INTO audit_log (id, user_id, at, action, detail) VALUES (?,?,?,?,?)",
      crypto.randomUUID(),
      c.get("userId"),
      new Date().toISOString(),
      "account_delete",
      account.id,
    );
    return c.json(ok({ deleted: true }));
  });

  /* ── 手動延長（SPEC §7.1 / §8.6） ─────────────────── */
  r.post("/:id/refresh-token", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const now = new Date();
    const jobCtx = jobContextFrom(c.env, db, c.get("budget"), now);
    const outcome = await refreshAccountToken(jobCtx, account, true);

    const after = (await db.first<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id=?`,
      account.id,
    ))!;
    const message =
      outcome === "refreshed"
        ? `トークンを延長しました。残り${remainingDays(after, now.getTime())}日です`
        : "このトークンは長期トークンではないため延長できません。Metaのアプリで作り直してください";
    return c.json(
      ok({
        refreshed: outcome === "refreshed",
        longLived: Boolean(after.token_long_lived),
        tokenExpiresInDays: tokenExpiresInDays(after, now.getTime()),
        message,
      }),
    );
  });

  /* ── 診断（6段。SPEC §7.1） ───────────────────────── */
  r.get("/:id/diagnose", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const options: CallOptions = { budget: c.get("budget"), env: c.env };
    const now = new Date();
    const steps: DiagnoseStep[] = [];

    const step = async (name: string, fn: () => Promise<string>) => {
      try {
        steps.push({ name, ok: true, detail: await fn() });
        return true;
      } catch (e) {
        steps.push({
          name,
          ok: false,
          detail:
            e instanceof ThreadsApiError
              ? threadsReason(e.toThreadsError())
              : "確認できませんでした",
        });
        return false;
      }
    };

    // 1. トークン
    let token = "";
    await step("トークン", async () => {
      token = await accountToken(c.env, account);
      const days = tokenExpiresInDays(account, now.getTime());
      return account.token_long_lived
        ? `長期トークン（残り約${days}日）`
        : "短期トークン。App Secret を入れて長期化すると自動更新できます";
    });

    // 2. /me
    let profileOk = false;
    if (token) {
      profileOk = await step("アカウント情報", async () => {
        const p = await getProfile(token, options);
        return `@${p.username}（ID ${p.id}）`;
      });
    }

    // 3. 投稿
    let sampleId: string | null = null;
    if (profileOk) {
      await step("投稿の取得", async () => {
        const page = await listThreads(token, { limit: 5 }, options);
        sampleId = page.data?.[0]?.id ?? null;
        return `直近${page.data?.length ?? 0}件を取得しました`;
      });
    }

    // 4. 投稿の数字
    if (profileOk) {
      if (!sampleId) {
        const row = await db.first<{ id: string }>(
          "SELECT id FROM posts WHERE account_id=? AND deleted=0 ORDER BY posted_at DESC LIMIT 1",
          account.id,
        );
        sampleId = row?.id ?? null;
      }
      if (sampleId) {
        await step("投稿の数字", async () => {
          const m = await getPostInsights(token, sampleId!, options);
          return `表示 ${m.views ?? 0} / いいね ${m.likes ?? 0}`;
        });
      } else {
        steps.push({ name: "投稿の数字", ok: true, detail: "まだ投稿がありません" });
      }
    }

    // 5. アカウントの表示回数
    if (profileOk) {
      await step("アカウントの表示回数", async () => {
        const untilSec = unixSec(now.getTime());
        const sinceSec = untilSec - 7 * 86400;
        const values = await getDailyViews(token, { sinceSec, untilSec }, options);
        return `${values.length}日分の日別データを取得しました`;
      });
    }

    // 6. クリック
    if (profileOk) {
      await step("リンクのクリック", async () => {
        const untilSec = unixSec(now.getTime());
        const sinceSec = untilSec - 7 * 86400;
        const values = await getLinkClicks(token, { sinceSec, untilSec }, options);
        return values.length > 0
          ? `${values.length}件のURLでクリックを取得しました`
          : "直近7日はクリックがありませんでした";
      });
    }

    return c.json(ok({ steps }));
  });

  /* ── 同期の投入と進捗（SPEC §7.1） ────────────────── */
  r.post("/:id/sync", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const jobCtx = jobContextFrom(c.env, db, c.get("budget"));
    const id = await enqueueJob(jobCtx, "full_sync", { accountId: account.id });
    return c.json(ok({ queued: id !== null }));
  });

  r.get("/:id/sync", async (c) => {
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const job = await db.first<{ status: string; state_json: string }>(
      "SELECT status, state_json FROM jobs WHERE type='full_sync' AND account_id=? ORDER BY created_at DESC LIMIT 1",
      account.id,
    );
    let progress = 0;
    try {
      const state = job ? (JSON.parse(job.state_json) as { pages?: number }) : {};
      progress = Math.min(SYNC_TOTAL_PAGES, Number(state?.pages ?? 0) || 0);
    } catch {
      progress = 0;
    }
    const running = job ? job.status === "pending" || job.status === "running" : false;
    return c.json(
      ok({
        running,
        progress: running ? progress : SYNC_TOTAL_PAGES,
        total: SYNC_TOTAL_PAGES,
      }),
    );
  });

  /* ── 設定（SPEC §7.1） ────────────────────────────── */
  r.patch("/:id", async (c) => {
    const parsed = patchSchema.safeParse(await readJson(c));
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const db = c.get("db");
    const account = await loadOwnedAccount(db, c.req.param("id"), c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const { color, timezone, settings } = parsed.data;
    if (timezone && !isValidTimezone(timezone)) {
      return fail("BAD_REQUEST", "タイムゾーンの指定が正しくありません", 400);
    }
    await db.run(
      "UPDATE accounts SET color=COALESCE(?,color), timezone=COALESCE(?,timezone), settings_json=COALESCE(?,settings_json) WHERE id=?",
      color ?? null,
      timezone ?? null,
      settings ? JSON.stringify(settings) : null,
      account.id,
    );
    const after = (await db.first<AccountRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id=?`,
      account.id,
    ))!;
    return c.json(ok({ account: toAccountSummary(after) }));
  });

  return r;
}

/**
 * `ap_plan`（毎時。SPEC §9.4）。
 *
 * enabled なアカウントごとに、今後24時間で足りないぶんの下書きを作ってキューに入れる。
 * 枠・型・ネタ源・リンクの選択は **すべてサーバー側の決定的な集計**（§9.3 / §9.4）で、
 * AI が呼ばれるのは本文の生成だけ（§10 冒頭）。
 *
 * 1. ライセンスが `active` か（`revoked` なら `enabled=0` にして終了。§5.4）
 * 2. 今後24時間で必要な本数（`per_week/7` の日割り − すでにある自動下書き）
 * 3. 枠（§9.3）→ 型（§9.4-3）→ ネタ源（`enabled_for_ap`・7日以内再使用なし）→ リンク
 * 4. 生成（§10.3 の AP プロンプト、n=1）。失敗は `ap_log` ＋ `consecutive_failures`、
 *    3連続で `enabled=0` ＋ 通知
 * 5. `queue` に挿入（`source='autopilot'`、承認方式ごとの status / `approve_deadline`）
 * 6. `ap_log`
 */
import {
  MIN_SAMPLES_LEARNING,
  buildTags,
  mondayIndex,
  pickHook,
  postsForDay,
  suggestSlot,
  validatePost,
  type SlotHistory,
} from "@tap/shared";
import { loadAccount, parseSettings, type AccountRow } from "../lib/accounts";
import {
  apLog,
  licenseActiveOrStop,
  loadAutopilot,
  recentAutoTags,
  type AutopilotRow,
} from "../lib/autopilot";
import { AiError, buildContext, defaultModel, generateRaw, readCandidates, systemPrompt } from "../lib/ai";
import { decrypt } from "../lib/crypto";
import type { Db } from "../lib/db";
import { isBudgetExceeded } from "../lib/budget";
import type { JobContext, RunningJob } from "../lib/jobs";
import { findDuplicate, publishSettings } from "../lib/queue";
import { sendEmail } from "../lib/email";
import { notifyTargets } from "../lib/notify";

/** 計画する先（SPEC §9.4-2「今後24時間」）。枠の候補は §9.3 が7日先まで出す。 */
export const PLAN_HORIZON_MS = 24 * 3_600_000;
/** 同じネタ源を再び使えるようになるまで（SPEC §9.4-3）。 */
export const SOURCE_REUSE_DAYS = 7;
/** 3回連続で失敗したら止める（SPEC §9.4-4 / §9.6）。 */
export const MAX_CONSECUTIVE_FAILURES = 3;
/** 1回の `ap_plan` で作る上限（暴走ガード）。必要本数がこれを超えても打ち切る。 */
export const MAX_PLANNED_PER_RUN = 4;
/** 生成が重複・検査に落ちたときの引き直し回数（暴走ガード）。 */
export const MAX_GENERATE_ATTEMPTS = 2;

/* ── 材料をそろえる ─────────────────────────────────── */

type SourceRow = { id: string; type: string; title: string; url: string | null; content: string };
type LinkRow = { id: string; url: string; label: string };

async function pickSource(db: Db, userId: string, now: Date): Promise<SourceRow | null> {
  const cutoff = new Date(now.getTime() - SOURCE_REUSE_DAYS * 86_400_000).toISOString();
  return db.first<SourceRow>(
    `SELECT id, type, title, url, content FROM sources
       WHERE user_id=? AND enabled_for_ap=1 AND (last_used_at IS NULL OR last_used_at < ?)
       ORDER BY (last_used_at IS NULL) DESC, last_used_at ASC, created_at ASC
       LIMIT 1`,
    userId,
    cutoff,
  );
}

async function pickLink(db: Db, accountId: string): Promise<LinkRow | null> {
  return db.first<LinkRow>(
    `SELECT id, url, label FROM links
       WHERE account_id=? AND enabled_for_ap=1
       ORDER BY (last_used_at IS NULL) DESC, last_used_at ASC, created_at ASC
       LIMIT 1`,
    accountId,
  );
}

/** 文体の見本。型が重ならないように score 上位から3本（SPEC §10.2）。 */
async function templates(db: Db, accountId: string): Promise<{ texts: string[]; firstId: string | null }> {
  const rows = await db.all<{ id: string; text: string; tags_json: string }>(
    `SELECT id, text, tags_json FROM posts
       WHERE account_id=? AND is_reply=0 AND deleted=0 AND text<>''
       ORDER BY views DESC LIMIT 30`,
    accountId,
  );
  const seen = new Set<string>();
  const texts: string[] = [];
  let firstId: string | null = null;
  for (const r of rows) {
    let hook = "";
    try {
      const t = JSON.parse(r.tags_json) as { hook?: unknown };
      if (typeof t.hook === "string") hook = t.hook;
    } catch {
      hook = "";
    }
    const key = hook === "" ? r.id : hook;
    if (seen.has(key)) continue;
    seen.add(key);
    if (firstId === null) firstId = r.id;
    texts.push(r.text);
    if (texts.length >= 3) break;
  }
  return { texts, firstId };
}

async function learningFor(db: Db, accountId: string, dim: string): Promise<SlotHistory[]> {
  const rows = await db.all<{ value: string; n: number; score_sum: number }>(
    "SELECT value, n, score_sum FROM learning WHERE account_id=? AND dim=? AND n>=?",
    accountId,
    dim,
    MIN_SAMPLES_LEARNING,
  );
  return rows.map((r) => ({ value: r.value, n: r.n, avgScore: r.n > 0 ? r.score_sum / r.n : 0 }));
}

/* ── AIキー（サーバー保存のみ。SPEC §7.7 の ON 条件） ── */

type ResolvedKey = { provider: "gemini" | "openrouter"; model: string; apiKey: string };

async function serverKey(ctx: JobContext, userId: string): Promise<ResolvedKey> {
  const row = await ctx.db.first<{
    provider: string;
    key_enc: string | null;
    model: string | null;
    store_on_server: number;
  }>(
    "SELECT provider, key_enc, model, store_on_server FROM ai_settings WHERE user_id=?",
    userId,
  );
  if (!row || !row.store_on_server || !row.key_enc) {
    throw new AiError(
      "AI_KEY_REQUIRED",
      "AIキーがサーバーに保存されていません（オートパイロットにはサーバー保存が必要です）",
    );
  }
  const provider = row.provider as "gemini" | "openrouter";
  return {
    provider,
    model: row.model && row.model.trim() !== "" ? row.model : defaultModel(provider),
    // 復号した値はこの関数を出たあと生成に渡すだけで、ログにもレスポンスにも出さない（SPEC §5.2）
    apiKey: await decrypt(row.key_enc, ctx.env.ENC_KEY),
  };
}

/* ── 1本ぶんの計画 ──────────────────────────────────── */

export type PlannedItem = {
  queueId: string;
  at: string;
  hook: string;
  sourceTitle: string;
};

async function planOne(
  ctx: JobContext,
  account: AccountRow,
  ap: AutopilotRow,
  key: ResolvedKey,
): Promise<PlannedItem> {
  const db = ctx.db;
  const settings = publishSettings(account);
  const recent = await recentAutoTags(db, account.id, 3);

  // 枠（SPEC §9.3）
  const taken = await db.all<{ scheduled_at: string }>(
    `SELECT scheduled_at FROM queue
       WHERE account_id=? AND status IN ('scheduled','pending_approval','publishing')
         AND scheduled_at IS NOT NULL`,
    account.id,
  );
  const slot = suggestSlot({
    nowMs: ctx.now.getTime(),
    tz: account.timezone,
    quietHours: ap.quiet_hours === 1,
    slotMode: ap.slot_mode as "auto" | "fixed",
    fixedHour: ap.fixed_hour,
    taken: taken.map((t) => t.scheduled_at),
    dailyLimit: ap.daily_limit,
    minGapMin: settings.minGapMin,
    history: await learningFor(db, account.id, "slot"),
    recentValues: recent.map((r) => r.slot).filter((v): v is string => v !== null),
  });

  // 型（SPEC §9.4-3）
  const hook = pickHook({
    history: await learningFor(db, account.id, "hook"),
    recentHooks: recent.map((r) => r.hook).filter((v): v is string => v !== null),
    mode: ap.hook_mode as "auto" | "fixed",
    fixedHook: ap.fixed_hook,
  });

  // ネタ源とリンク
  const source = await pickSource(db, account.user_id, ctx.now);
  if (!source) {
    throw new AiError(
      "AI_FAILED",
      `使えるネタ源がありません（${SOURCE_REUSE_DAYS}日以内に使ったものは選びません）`,
    );
  }
  const link = ap.link_placement === "none" ? null : await pickLink(db, account.id);

  const tpl = await templates(db, account.id);
  const emojiSetting = parseSettings(account).emoji === "few" ? "few" : "none";
  const constraints = {
    linkPlacement: ap.link_placement as "comment" | "body" | "none",
    ngWords: ap.ng_words,
    emoji: emojiSetting as "none" | "few",
  };

  const youtubeUrls =
    source.type === "youtube" && source.url && key.provider === "gemini" ? [source.url] : [];
  const sourcesForPrompt =
    source.content.trim() === "" ? [] : [{ title: source.title, content: source.content }];

  // 生成（SPEC §10.3 の AP プロンプト。型は固定、n=1）
  let body = "";
  let comments: string[] = [];
  let lastIssue = "";
  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
    const raw = await generateRaw(
      ctx.env,
      {
        provider: key.provider,
        model: key.model,
        apiKey: key.apiKey,
        system: systemPrompt(constraints),
        user: buildContext({
          templates: tpl.texts,
          rewriteFrom: null,
          sources: sourcesForPrompt,
          youtubeUrls,
          links: link ? [{ label: link.label, url: link.url }] : [],
          instruction:
            attempt === 0
              ? "オートパイロットの自動投稿です。参考情報の中身を1つの話にまとめる。"
              : `オートパイロットの自動投稿です。前回の案は「${lastIssue}」で使えませんでした。別の切り口で書き直す。`,
          n: 1,
          fixedHook: hook.hook,
        }),
        youtubeUrls,
        appOrigin: ctx.env.APP_ORIGIN,
      },
      { budget: ctx.budget },
    );
    const [candidate] = readCandidates(raw, 1);
    body = candidate!.body;
    comments = candidate!.comments;
    if (link && ap.link_placement === "comment") {
      // リンクはコメント側に置く（本文に URL があると下の validatePost で落ちる）
      comments = comments.length > 0 ? [...comments] : [""];
      if (!comments[0]!.includes(link.url)) {
        comments[0] = `${comments[0]!.trim()}\n${link.url}`.trim();
      }
    }

    // 安全装置（SPEC §9.6）。AP 経由なので link_placement を効かせる
    const check = validatePost(body, {
      comments,
      linkPlacement: ap.link_placement as "comment" | "body" | "none",
      ngWords: ap.ng_words,
    });
    if (!check.ok) {
      lastIssue = check.issues[0]!.message;
      continue;
    }
    const dup = await findDuplicate(db, account.id, body, { nowMs: ctx.now.getTime() });
    if (dup) {
      lastIssue = "直近30日に似た内容の投稿があります";
      continue;
    }
    lastIssue = "";
    break;
  }
  if (lastIssue !== "") throw new AiError("AI_FAILED", `下書きを作れませんでした（${lastIssue}）`);

  // キューに入れる（SPEC §9.4-5）
  const tags = {
    ...buildTags(body, new Date(slot.at), account.timezone),
    source_id: source.id,
    link: link ? ap.link_placement : "none",
    hook: hook.hook,
  };
  const status = ap.approval_mode === "manual" ? "pending_approval" : "scheduled";
  const approveDeadline =
    ap.approval_mode === "cancel"
      ? new Date(Date.parse(slot.at) - ap.approval_window_h * 3_600_000).toISOString()
      : null;

  const id = crypto.randomUUID();
  const nowIso = ctx.now.toISOString();
  await db.run(
    `INSERT INTO queue (id, account_id, status, scheduled_at, body, comments_json, image_url, reply_control,
        source, approval_mode, approve_deadline, notified_at, action_token_used_at, step, next_step_at,
        container_id, container_polls, result_ids_json, error, error_raw, attempts, tags_json,
        origin_post_id, source_ids_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,NULL,'everyone','autopilot',?,?,NULL,NULL,0,NULL,NULL,0,'[]',NULL,NULL,0,?,?,?,?,?)`,
    id,
    account.id,
    status,
    slot.at,
    body,
    JSON.stringify(comments.filter((c) => c.trim() !== "")),
    ap.approval_mode,
    approveDeadline,
    JSON.stringify(tags),
    tpl.firstId,
    JSON.stringify([source.id]),
    nowIso,
    nowIso,
  );

  await db.run(
    "UPDATE sources SET last_used_at=?, use_count=use_count+1 WHERE id=?",
    nowIso,
    source.id,
  );
  if (link) {
    await db.run("UPDATE links SET last_used_at=? WHERE id=?", nowIso, link.id);
  }

  return { queueId: id, at: slot.at, hook: hook.hook, sourceTitle: source.title };
}

/* ── 何本足りないか（SPEC §9.4-2） ───────────────────── */

/**
 * 今後24時間で作るべき本数。`per_week/7` の日割りから、**まだ出ていない自動下書き**
 * （`source='autopilot'` の `pending_approval|scheduled`）を差し引く（SPEC §9.4-2）。
 *
 * 差し引くのは「24時間以内のぶん」ではなく**未消化の全部**。枠が埋まっていて先の日に
 * 置かれた下書きを数え落とすと、毎時それを無視してもう1本作り、どんどん先へ積み上がる
 * （ブラウザ確認で踏んだ）。`daily_limit` は枠の側で効くので、在庫で止めるのが正しい。
 */
export async function neededCount(
  db: Db,
  account: AccountRow,
  ap: AutopilotRow,
  now: Date,
): Promise<number> {
  const dow = mondayIndex(
    new Date(
      new Date(now).toLocaleString("en-US", { timeZone: account.timezone }),
    ).getDay(),
  );
  const want = postsForDay(ap.per_week, dow);
  const have = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM queue
       WHERE account_id=? AND source='autopilot' AND status IN ('pending_approval','scheduled')
         AND scheduled_at IS NOT NULL`,
    account.id,
  );
  return Math.max(0, Math.min(MAX_PLANNED_PER_RUN, want - (have?.n ?? 0)));
}

/* ── 失敗の記録と自動停止（SPEC §9.4-4 / §9.6） ──────── */

async function recordFailure(
  ctx: JobContext,
  account: AccountRow,
  message: string,
): Promise<void> {
  const nowIso = ctx.now.toISOString();
  await ctx.db.run(
    `INSERT INTO autopilot (account_id, consecutive_failures, updated_at) VALUES (?,1,?)
       ON CONFLICT(account_id) DO UPDATE SET
         consecutive_failures = consecutive_failures + 1, updated_at = excluded.updated_at`,
    account.id,
    nowIso,
  );
  await apLog(ctx.db, account.id, "error", `下書きを作れませんでした: ${message}`, null, ctx.now);

  const row = await ctx.db.first<{ consecutive_failures: number }>(
    "SELECT consecutive_failures FROM autopilot WHERE account_id=?",
    account.id,
  );
  if ((row?.consecutive_failures ?? 0) < MAX_CONSECUTIVE_FAILURES) return;

  await ctx.db.run(
    "UPDATE autopilot SET enabled=0, updated_at=? WHERE account_id=?",
    nowIso,
    account.id,
  );
  await apLog(
    ctx.db,
    account.id,
    "stopped",
    `${MAX_CONSECUTIVE_FAILURES}回続けて失敗したので、オートパイロットを止めました`,
    null,
    ctx.now,
  );
  const target = await notifyTargets(ctx.db, account.id);
  if (target) {
    await sendEmail(ctx.env, target.email, "ap_stopped", {
      username: account.username,
      reason: message,
      appOrigin: ctx.env.APP_ORIGIN,
    });
  }
}

async function clearFailures(ctx: JobContext, accountId: string): Promise<void> {
  await ctx.db.run(
    "UPDATE autopilot SET consecutive_failures=0, updated_at=? WHERE account_id=? AND consecutive_failures>0",
    ctx.now.toISOString(),
    accountId,
  );
}

/* ── ジョブ本体 ─────────────────────────────────────── */

export type PlanSummary = { planned: PlannedItem[]; skipped: string | null };

export async function planAccount(ctx: JobContext, accountId: string): Promise<PlanSummary> {
  const account = await loadAccount(ctx.db, accountId);
  if (!account) return { planned: [], skipped: "アカウントがありません" };

  const ap = await loadAutopilot(ctx.db, accountId);
  if (!ap.enabled) return { planned: [], skipped: "オートパイロットがオフです" };

  // needs_reauth のアカウントは計画しない（SPEC §9.6）
  if (account.status !== "ok") {
    return { planned: [], skipped: "アカウントの再接続が必要です" };
  }
  // ライセンス（SPEC §5.4）
  if (!(await licenseActiveOrStop(ctx.db, accountId, ctx.now))) {
    return { planned: [], skipped: "ライセンスが無効です" };
  }

  const need = await neededCount(ctx.db, account, ap, ctx.now);
  if (need === 0) return { planned: [], skipped: null };

  let key: ResolvedKey;
  try {
    key = await serverKey(ctx, account.user_id);
  } catch (e) {
    await recordFailure(ctx, account, e instanceof Error ? e.message : String(e));
    return { planned: [], skipped: "AIキーがありません" };
  }

  const planned: PlannedItem[] = [];
  for (let i = 0; i < need; i++) {
    try {
      const item = await planOne(ctx, account, ap, key);
      planned.push(item);
      await apLog(
        ctx.db,
        accountId,
        "plan",
        `${formatSlot(item.at, account.timezone)}の下書きを作りました（${item.hook} / ネタ源: ${item.sourceTitle}）`,
        item.queueId,
        ctx.now,
      );
    } catch (e) {
      if (isBudgetExceeded(e)) throw e; // 予算切れは失敗ではない。次回続きから
      await recordFailure(ctx, account, e instanceof Error ? e.message : String(e));
      return { planned, skipped: "生成に失敗しました" };
    }
  }
  if (planned.length > 0) await clearFailures(ctx, accountId);
  return { planned, skipped: null };
}

/** `9/2 21:00` の形（アカウントの timezone）。 */
export function formatSlot(iso: string, tz: string): string {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("ja-JP", {
    timeZone: tz,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return f.format(d).replace(/\s+/g, " ");
}

export async function apPlanJob(ctx: JobContext, job: RunningJob): Promise<void> {
  if (!job.accountId) return;
  const summary = await planAccount(ctx, job.accountId);
  job.state.planned = summary.planned.length;
  if (summary.skipped) job.state.skipped = summary.skipped;
}

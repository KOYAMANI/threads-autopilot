import { Hono, type Context } from "hono";
import { ok } from "@tap/shared";
import type { AiGenerateResponse, AiGenerationContext } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { decrypt, encrypt } from "../lib/crypto";
import { createJobContext, enqueueJob, jobContextFrom, runJobs } from "../lib/jobs";
import { audit } from "../lib/audit";
import { loadOwnedAccount } from "../lib/accounts";
import { aiRateLimit, generateSchema } from "./ai";

type TaskRow = {
  id: string;
  account_id: string;
  state_json: string;
  status: "pending" | "running" | "done" | "failed";
  created_at: string;
  updated_at: string;
  last_error: string | null;
};

type TaskState = {
  inputEnc?: string;
  resultEnc?: string;
  outcome?: "done" | "failed" | "cancelled";
  error?: { code?: string; message?: string; status?: number; detail?: unknown };
};

const STALE_GENERATION_TASK_MS = 10 * 60_000;

function parseState(value: string): TaskState {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as TaskState : {};
  } catch {
    return {};
  }
}

async function ownedTask(c: Context<AppEnv>, id: string): Promise<TaskRow | null> {
  return c.get("db").first<TaskRow>(
    `SELECT j.id,j.account_id,j.state_json,j.status,j.created_at,j.updated_at,j.last_error
       FROM jobs j JOIN accounts a ON a.id=j.account_id
      WHERE j.id=? AND j.type='ai_generate' AND a.user_id=?`,
    id,
    c.get("userId")!,
  );
}

export function aiTaskRoutes() {
  const r = new Hono<AppEnv>();

  r.post("/generation-tasks", aiRateLimit, async c => {
    let body: unknown = null;
    try { body = await c.req.json(); } catch { body = null; }
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) return fail("BAD_REQUEST", "入力に誤りがあります", 400);
    const account = await loadOwnedAccount(c.get("db"), parsed.data.accountId, c.get("userId")!);
    if (!account) return fail("NOT_FOUND", "見つかりませんでした", 404);

    const jobContext = jobContextFrom(c.env, c.get("db"), c.get("budget"));
    const id = await enqueueJob(jobContext, "ai_generate", {
      accountId: account.id,
      priority: 2,
      force: true,
      state: { inputEnc: await encrypt(JSON.stringify(parsed.data), c.env.ENC_KEY) },
    });
    if (!id) return fail("INTERNAL", "生成タスクを開始できませんでした", 500);

    await audit(c.get("db"), c.get("userId")!, "ai_request", { operation: "generate_task", success: true, taskId: id });
    if (c.env.JOB_QUEUE) {
      await c.env.JOB_QUEUE.send({ jobId: id });
    } else {
      // 本番・staging は Queue binding がある。ローカルは同一リクエストの
      // waitUntil でD1ロック待ちになるため、開発時だけここで完了まで進める。
      await runJobs(createJobContext(c.env), undefined, id);
    }
    return c.json(ok({ taskId: id, status: "pending" as const, startedAt: new Date().toISOString() }), 202);
  });

  r.get("/generation-tasks/:id", async c => {
    const row = await ownedTask(c, c.req.param("id"));
    if (!row) return fail("NOT_FOUND", "生成タスクが見つかりませんでした", 404);
    const state = parseState(row.state_json);
    if ((row.status === "pending" || row.status === "running") && Date.now() - Date.parse(row.created_at) >= STALE_GENERATION_TASK_MS) {
      const error = { code: "AI_FAILED", message: "生成処理を完了できませんでした。入力は保持しています。もう一度お試しください。", status: 502 };
      await c.get("db").run(
        `UPDATE jobs SET status='failed', state_json=json_set(state_json,'$.outcome','failed','$.error',json(?)), last_error=?, updated_at=?
          WHERE id=? AND status IN ('pending','running')`,
        JSON.stringify(error),
        "generation task exceeded ten-minute lifecycle",
        new Date().toISOString(),
        row.id,
      );
      state.outcome = "failed";
      state.error = error;
      row.status = "failed";
      row.updated_at = new Date().toISOString();
    }
    let context: AiGenerationContext | undefined;
    if (state.inputEnc) {
      try {
        const input = JSON.parse(await decrypt(state.inputEnc, c.env.ENC_KEY)) as Record<string, unknown>;
        const { accountId: _accountId, clientKey: _clientKey, n: _n, ...rest } = input;
        context = rest as AiGenerationContext;
      } catch { /* failed response below explains an unreadable task */ }
    }

    if (row.status === "done" && state.outcome === "done" && state.resultEnc) {
      try {
        const result = JSON.parse(await decrypt(state.resultEnc, c.env.ENC_KEY)) as AiGenerateResponse;
        return c.json(ok({ taskId: row.id, accountId: row.account_id, status: "done" as const, startedAt: row.created_at, finishedAt: row.updated_at, context, result }));
      } catch {
        return fail("INTERNAL", "完成した投稿案を復元できませんでした", 500);
      }
    }
    if (row.status === "failed" || state.outcome === "failed" || state.outcome === "cancelled") {
      return c.json(ok({
        taskId: row.id,
        accountId: row.account_id,
        status: state.outcome === "cancelled" ? "cancelled" as const : "failed" as const,
        startedAt: row.created_at,
        finishedAt: row.updated_at,
        context,
        error: state.error ?? { code: "AI_FAILED", message: "生成できませんでした。入力は保持しています。", status: 502 },
      }));
    }
    return c.json(ok({ taskId: row.id, accountId: row.account_id, status: row.status, startedAt: row.created_at, context }));
  });

  r.delete("/generation-tasks/:id", async c => {
    const row = await ownedTask(c, c.req.param("id"));
    if (!row) return fail("NOT_FOUND", "生成タスクが見つかりませんでした", 404);
    const error = { code: "CANCELLED", message: "生成を中止しました。入力は保持しています。", status: 0 };
    await c.get("db").run(
      `UPDATE jobs SET status='failed', state_json=json_set(state_json,'$.outcome','cancelled','$.error',json(?)), updated_at=?
        WHERE id=? AND status IN ('pending','running')`,
      JSON.stringify(error),
      new Date().toISOString(),
      row.id,
    );
    return c.json(ok({ cancelled: true }));
  });

  return r;
}

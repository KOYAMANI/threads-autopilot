import { AI_GENERATION_TIMEOUT_MS } from "@tap/shared";
import type { AiGenerateResponse } from "@tap/shared";
import { decrypt, encrypt } from "../lib/crypto";
import { AiError } from "../lib/ai";
import { pushToUser } from "../lib/notify";
import type { JobHandler } from "../lib/jobs";
import {
  AiGenerationInputError,
  executeGeneration,
  generateSchema,
  type GenerateInput,
} from "../routes/ai";

type StoredError = {
  code: string;
  message: string;
  status: number;
  detail?: {
    requestId: string;
    category?: string;
    reason?: string;
    upstreamStatus?: number;
    retryable?: boolean;
  };
};

function publicAiError(error: AiError): StoredError {
  const referenceError = ["input", "content_validation", "reference_unresolved", "reference_invalid", "reference_too_long"].includes(error.category);
  const status = referenceError ? 422 : error.code === "AI_KEY_REQUIRED" ? 400 : 502;
  return {
    code: error.code,
    message: error.code === "AI_BAD_OUTPUT" && !referenceError
      ? "AIの生成結果がアプリの検証条件を満たしませんでした。入力は保持しています。再試行し、続く場合は診断情報を運営へお知らせください。"
      : error.message,
    status,
    detail: {
      requestId: crypto.randomUUID(),
      category: error.category,
      reason: error.reason,
      upstreamStatus: error.upstreamStatus,
      retryable: error.retryable,
    },
  };
}

/** 入力と結果は jobs.state_json の中でも暗号文として保持する。 */
export const aiGenerateJob: JobHandler = async (ctx, job) => {
  if (!job.accountId || typeof job.state.inputEnc !== "string") {
    job.state.outcome = "failed";
    job.state.error = { code: "BAD_REQUEST", message: "生成タスクの入力を確認できませんでした", status: 400 } satisfies StoredError;
    return;
  }

  const owner = await ctx.db.first<{ user_id: string }>("SELECT user_id FROM accounts WHERE id=?", job.accountId);
  if (!owner) {
    job.state.outcome = "failed";
    job.state.error = { code: "NOT_FOUND", message: "投稿先が見つかりませんでした", status: 404 } satisfies StoredError;
    return;
  }

  let input: GenerateInput;
  try {
    const parsed = generateSchema.safeParse(JSON.parse(await decrypt(job.state.inputEnc, ctx.env.ENC_KEY)));
    if (!parsed.success) throw new Error("invalid task input");
    input = parsed.data;
  } catch {
    job.state.outcome = "failed";
    job.state.error = { code: "BAD_REQUEST", message: "生成タスクの入力を復元できませんでした", status: 400 } satisfies StoredError;
    return;
  }

  try {
    const result: AiGenerateResponse = await executeGeneration({
      env: ctx.env,
      db: ctx.db,
      budget: ctx.budget,
      userId: owner.user_id,
      input,
      deadlineMs: Date.now() + AI_GENERATION_TIMEOUT_MS,
    });
    job.state.resultEnc = await encrypt(JSON.stringify(result), ctx.env.ENC_KEY);
    job.state.outcome = "done";
    delete job.state.error;
    await pushToUser(ctx.env, ctx.db, owner.user_id, {
      title: "3案できました",
      body: "投稿案を確認できます。",
      url: `/app/create?generation=${encodeURIComponent(job.id)}`,
    });
  } catch (error) {
    if (error instanceof AiGenerationInputError) {
      job.state.outcome = "failed";
      job.state.error = { code: error.code, message: error.message, status: error.status } satisfies StoredError;
      return;
    }
    if (error instanceof AiError) {
      job.state.error = publicAiError(error);
      // callAi/compose already perform their single bounded retry. Throwing here made the
      // generic job runner retry the whole generation up to four more times, consuming
      // provider quota and leaving the browser polling a pending job between attempts.
      job.state.outcome = "failed";
      return;
    }
    throw error;
  }
};

/**
 * ジョブ種別 → ハンドラの対応表（SPEC §8.2）。
 * `lib/jobs.ts` の `runJobs()` はこの表だけを見る。
 * `publish`（§8.3）は M4、`ap_plan` / `ap_notify` / `ap_score`（§9）は M6。
 */
import type { JobHandler, JobType } from "../lib/jobs";
import { dailyViewsJob, demographicsJob, followersJob } from "./account-metrics";
import { clicksJob } from "./clicks";
import { insightsJob } from "./insights";
import { cleanupJob, tokenRefreshJob } from "./maintenance";
import { fullSyncJob } from "./sync";

export const HANDLERS: Partial<Record<JobType, JobHandler>> = {
  full_sync: fullSyncJob,
  insights_recent: insightsJob("recent"),
  insights_daily: insightsJob("daily"),
  insights_old: insightsJob("old"),
  daily_views: dailyViewsJob,
  followers: followersJob,
  demographics: demographicsJob,
  clicks: clicksJob,
  token_refresh: tokenRefreshJob,
  cleanup: cleanupJob,
};

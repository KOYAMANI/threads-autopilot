/**
 * ジョブ種別 → ハンドラの対応表（SPEC §8.2）。
 * `lib/jobs.ts` の `runJobs()` はこの表だけを見る。
 * `ap_plan` / `ap_notify` / `ap_score` は §9（M6）。
 */
import type { JobHandler, JobType } from "../lib/jobs";
import { dailyViewsJob, demographicsJob, followersJob } from "./account-metrics";
import { clicksJob } from "./clicks";
import { insightsJob } from "./insights";
import { cleanupJob, tokenRefreshJob } from "./maintenance";
import { publishJob } from "./publish";
import { fullSyncJob } from "./sync";
import { apPlanJob } from "./plan";
import { apNotifyJob } from "./notify";
import { apScoreJob } from "./score";
import { sheetsSyncJob } from "./sheets";
import { dailyDigestJob } from "./digest";

export const HANDLERS: Partial<Record<JobType, JobHandler>> = {
  publish: publishJob,
  sheets_sync: sheetsSyncJob,
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
  ap_plan: apPlanJob,
  ap_notify: apNotifyJob,
  ap_score: apScoreJob,
  daily_digest: dailyDigestJob,
};

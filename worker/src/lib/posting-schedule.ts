import {
  DEFAULT_POSTING_TIMES, localDateKey, normalizePostingTimes, postingSlotsForDate,
  upcomingPostingSlots, startOfTzDay, type PostingSchedule,
} from "@tap/shared";
import type { AccountRow } from "./accounts";
import type { Db } from "./db";
import { publishSettings } from "./queue";

export async function loadPostingSchedule(db: Db, account: AccountRow): Promise<PostingSchedule> {
  const row = await db.first<{ times_json: string }>("SELECT times_json FROM posting_schedules WHERE account_id=?", account.id);
  let times = DEFAULT_POSTING_TIMES;
  if (row) {
    try { times = normalizePostingTimes(JSON.parse(row.times_json)) ?? DEFAULT_POSTING_TIMES; } catch { /* use defaults */ }
  }
  return { timezone: account.timezone, times: [...times] };
}

export function isSlotConflict(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  return /POSTING_SLOT_OCCUPIED|AUTOPILOT_DAILY_LIMIT|posting_slot_reservations/.test(message);
}

export async function availablePostingSlots(
  db: Db, account: AccountRow, now: Date,
  options: { autopilotLimit?: number; quietHours?: boolean; untilMs?: number; excludeQueueId?: string } = {},
): Promise<Array<{ at: string; time: string }>> {
  const schedule = await loadPostingSchedule(db, account);
  const candidates = upcomingPostingSlots(now.getTime(), schedule.times, account.timezone)
    .filter((s) => options.untilMs === undefined || Date.parse(s.at) <= options.untilMs);
  if (!candidates.length) return [];
  const settings = publishSettings(account);
  const gapMs = settings.minGapMin * 60_000;
  const since = new Date(now.getTime() - 2 * 86_400_000 - gapMs).toISOString();
  const until = new Date(Date.parse(candidates[candidates.length - 1]!.at) + gapMs + 1).toISOString();
  const [rows, reserved] = await Promise.all([
    db.all<{ id: string; source: string; status: string; scheduled_at: string }>(
      `SELECT id, source, status, scheduled_at FROM queue WHERE account_id=? AND scheduled_at>=? AND scheduled_at<? AND id<>?`,
      account.id, since, until, options.excludeQueueId ?? "",
    ),
    db.all<{ scheduled_at: string; queue_id: string | null; reservation_key: string; source: string; local_day: string }>(
      `SELECT scheduled_at, queue_id, reservation_key, source, local_day FROM posting_slot_reservations WHERE account_id=? AND scheduled_at>=? AND scheduled_at<?`,
      account.id, since, until,
    ),
  ]);
  const taken = rows.filter((r) => ["scheduled", "pending_approval", "publishing", "done"].includes(r.status));
  const reservedAt = new Set(reserved.filter((r) => r.queue_id !== options.excludeQueueId).map((r) => r.scheduled_at));
  const autoPerDay = new Map<string, Set<string>>();
  const countAuto = (day: string, key: string) => {
    const set = autoPerDay.get(day) ?? new Set<string>();
    set.add(key); autoPerDay.set(day, set);
  };
  for (const r of rows) if (r.source === "autopilot" && r.status !== "draft") {
    countAuto(localDateKey(Date.parse(r.scheduled_at), account.timezone), r.id);
  }
  for (const r of reserved) if (r.source === "autopilot") {
    countAuto(localDateKey(Date.parse(r.scheduled_at), account.timezone), r.reservation_key);
  }
  return candidates.filter((s) => {
    const ms = Date.parse(s.at);
    const day = localDateKey(ms, account.timezone);
    if (options.quietHours && Number(s.time.slice(0, 2)) < 7) return false;
    if (reservedAt.has(s.at)) return false;
    if (taken.some((q) => q.scheduled_at === s.at || Math.abs(Date.parse(q.scheduled_at) - ms) < gapMs)) return false;
    if (taken.filter((q) => localDateKey(Date.parse(q.scheduled_at), account.timezone) === day).length >= settings.dailyPostLimit) return false;
    if (options.autopilotLimit !== undefined && (autoPerDay.get(day)?.size ?? 0) >= Math.min(3, options.autopilotLimit)) return false;
    return true;
  });
}

export async function nextPostingSlot(db: Db, account: AccountRow, now = new Date(), excludeQueueId?: string) {
  const [next] = await availablePostingSlots(db, account, now, { excludeQueueId });
  return next ?? null;
}

export function isValidScheduleDate(date: string, tz: string): boolean {
  return postingSlotsForDate(date, ["12:00"], tz).length === 1;
}

/** Calendar selection uses the same ownership, schedule, gap, and daily cap as next-slot booking. */
export async function canReservePostingSlot(db: Db, account: AccountRow, at: string | null, excludeQueueId?: string): Promise<boolean> {
  if (!at || Date.parse(at) <= Date.now()) return false;
  const schedule = await loadPostingSchedule(db, account);
  const day = localDateKey(Date.parse(at), account.timezone);
  if (!postingSlotsForDate(day, schedule.times, account.timezone).some((s) => s.at === at)) return false;
  const settings = publishSettings(account);
  const gapMs = settings.minGapMin * 60_000;
  const start = startOfTzDay(Date.parse(at), account.timezone);
  const near = await db.all<{ scheduled_at: string }>(
    `SELECT scheduled_at FROM queue WHERE account_id=? AND id<>? AND status IN ('scheduled','pending_approval','publishing','done')
       AND scheduled_at>=? AND scheduled_at<?`,
    account.id, excludeQueueId ?? "", new Date(start - gapMs).toISOString(), new Date(start + 26 * 3_600_000 + gapMs).toISOString(),
  );
  if (near.some((q) => q.scheduled_at === at || Math.abs(Date.parse(q.scheduled_at) - Date.parse(at)) < gapMs)) return false;
  return near.filter((q) => localDateKey(Date.parse(q.scheduled_at), account.timezone) === day).length < settings.dailyPostLimit;
}

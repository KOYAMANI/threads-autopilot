import { describe, expect, it } from "vitest";
import { localDateKey, normalizePostingTimes, postingSlotsForDate, upcomingPostingSlots } from "../src/slot";

describe("daily posting slots", () => {
  it("validates minutes, duplicates and the ten-slot limit", () => {
    expect(normalizePostingTimes(["21:45", "09:05"])).toEqual(["09:05", "21:45"]);
    for (const value of [[], ["9:00"], ["24:00"], ["12:60"], ["09:00", "09:00"], Array.from({ length: 11 }, (_, h) => `${String(h).padStart(2, "0")}:00`)]) {
      expect(normalizePostingTimes(value)).toBeNull();
    }
  });
  it("uses the account timezone and rolls midnight to the following local day", () => {
    const now = Date.parse("2026-09-07T14:59:00Z");
    const slots = upcomingPostingSlots(now, ["00:15", "09:05"], "Asia/Tokyo", 1);
    expect(slots[0]).toEqual({ time: "00:15", at: "2026-09-07T15:15:00.000Z" });
    expect(localDateKey(Date.parse(slots[0]!.at), "Asia/Tokyo")).toBe("2026-09-08");
  });
  it("omits nonexistent DST time and emits a repeated hour only once", () => {
    expect(postingSlotsForDate("2026-03-08", ["02:30", "03:30"], "America/New_York"))
      .toEqual([{ time: "03:30", at: "2026-03-08T07:30:00.000Z" }]);
    const fall = postingSlotsForDate("2026-11-01", ["01:30"], "America/New_York");
    expect(fall).toHaveLength(1);
    expect(localDateKey(Date.parse(fall[0]!.at), "America/New_York")).toBe("2026-11-01");
  });
  it("rejects impossible calendar dates", () => {
    expect(postingSlotsForDate("2026-02-30", ["12:00"], "Asia/Tokyo")).toEqual([]);
  });
});

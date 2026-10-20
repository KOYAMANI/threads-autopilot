/** 投稿を次の空き枠へ入れるか、日時を指定する。枠の確保は保存時にサーバーで行う。 */
import { useEffect, useState } from "react";
import { useSuggestSlot } from "../api/queue";
import { ApiError } from "../api/client";
import { fromDateTimeLocal, mdhm, toDateTimeLocal } from "../lib/format";
import { usePublishingCapability } from "../api/publishing";
import Sheet from "./Sheet";

export type SchedulePick = { kind: "at" | "next_slot"; at: string | null };

export default function ScheduleSheet({
  open, onClose, onPick, accountId, tz, title = "いつ投稿する",
  confirmLabel = "この時間で予約する", initialAt = null, busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (pick: SchedulePick) => void;
  accountId: string | null;
  tz: string;
  title?: string;
  confirmLabel?: string;
  initialAt?: string | null;
  busy?: boolean;
}) {
  const capability = usePublishingCapability();
  const [mode, setMode] = useState<"at" | "slot" | "next_day">("slot");
  const [local, setLocal] = useState("");
  const slot = useSuggestSlot(accountId, open);
  useEffect(() => {
    if (!open) return;
    setMode(initialAt ? "at" : "slot");
    setLocal(toDateTimeLocal(initialAt ?? Date.now() + 3600_000, tz));
  }, [open, initialAt, tz]);

  const atIso = mode === "at" ? fromDateTimeLocal(local, tz) : mode === "next_day" ? (slot.data?.nextDayAt ?? null) : (slot.data?.at ?? null);
  const invalidDate = mode === "at" && (!atIso || new Date(atIso).getTime() <= Date.now());
  const ready = capability.data?.enabled === true && (mode === "at" ? !invalidDate : Boolean(atIso && !slot.isError));

  function confirm() {
    if (!ready) return;
    onPick({ kind: mode === "slot" ? "next_slot" : "at", at: atIso });
  }

  return <Sheet open={open} onClose={onClose} title={title}>
    {capability.data?.enabled === false && <p className="msg msg-warn" role="status">この検証用ログインでは予約実行を停止しています。下書きとして保存してください。</p>}
    {capability.isError && <p className="msg msg-bad" role="alert">投稿可否を確認できません。画面を再読み込みしてください。</p>}
    <div className="choices" role="radiogroup" aria-label="投稿する日時">
      <button type="button" className="choice" role="radio" aria-checked={mode === "slot"} disabled={busy} onClick={() => setMode("slot")}>
        <span className="choice-title">次の空き枠</span>
        <span className="choice-note">{slot.isPending ? "空き枠を探しています…" : slot.isError ? "空き枠を取得できませんでした" : slot.data ? `${mdhm(slot.data.at, tz)} ・ ${tz}` : "空き枠がありません"}</span>
      </button>
      <button type="button" className="choice" role="radio" aria-checked={mode === "next_day"} disabled={busy || !slot.data?.nextDayAt} onClick={() => setMode("next_day")}>
        <span className="choice-title">次の日の枠</span>
        <span className="choice-note">{slot.isPending ? "空き枠を探しています…" : slot.data?.nextDayAt ? `${mdhm(slot.data.nextDayAt, tz)} ・ ${tz}` : "次の日に空き枠がありません"}</span>
      </button>
      {(mode === "slot" || mode === "next_day") && slot.isError && <p className="msg msg-warn" role="alert">{slot.error instanceof ApiError ? slot.error.message : "「下書き・予約」で投稿スロットを確認してください。"}</p>}
      <button type="button" className="btn-quiet schedule-deeper" disabled={busy} onClick={() => setMode("at")}>日時を指定する →</button>
      {mode === "at" && <><input type="datetime-local" className="input" aria-label="投稿する日時" value={local} disabled={busy} onChange={e => setLocal(e.target.value)} />{invalidDate && <p className="muted" role="status">これからの日時を指定してください。</p>}</>}
    </div>
    {(mode === "slot" || mode === "next_day") && slot.data && !slot.isError && <p className="schedule-note section">保存した時点の空き枠を使います。今すぐ公開する場合は、承認画面の ⋯ から選べます。</p>}
    {mode === "at" && !invalidDate && atIso && <p className="muted section">{mdhm(atIso, tz)} に出します</p>}
    <button type="button" className="btn section" disabled={busy || !ready} onClick={confirm}>{busy ? "送っています…" : confirmLabel}</button>
  </Sheet>;
}

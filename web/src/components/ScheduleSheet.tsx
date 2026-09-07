/** 投稿を次の空き枠へ入れるか、日時を指定する。枠の確保は保存時にサーバーで行う。 */
import { useEffect, useState } from "react";
import { useSuggestSlot } from "../api/queue";
import { ApiError } from "../api/client";
import { fromDateTimeLocal, mdhm, toDateTimeLocal } from "../lib/format";
import Sheet from "./Sheet";

export type SchedulePick = { kind: "now" | "at" | "next_slot"; at: string | null };

export default function ScheduleSheet({
  open, onClose, onPick, accountId, tz, title = "いつ出す？",
  confirmLabel = "予約する", initialAt = null, busy = false,
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
  const [mode, setMode] = useState<"now" | "at" | "slot">("slot");
  const [local, setLocal] = useState("");
  const slot = useSuggestSlot(accountId, open && mode === "slot");
  useEffect(() => {
    if (!open) return;
    setMode(initialAt ? "at" : "slot");
    setLocal(toDateTimeLocal(initialAt ?? Date.now() + 3600_000, tz));
  }, [open, initialAt, tz]);

  const atIso = mode === "at" ? fromDateTimeLocal(local, tz) : (slot.data?.at ?? null);
  const invalidDate = mode === "at" && (!atIso || new Date(atIso).getTime() <= Date.now());
  const ready = mode === "now" || (mode === "at" ? !invalidDate : Boolean(slot.data && !slot.isError));

  function confirm() {
    if (!ready) return;
    onPick({ kind: mode === "now" ? "now" : mode === "slot" ? "next_slot" : "at", at: mode === "now" ? null : atIso });
  }

  return <Sheet open={open} onClose={onClose} title={title}>
    <div className="choices" role="radiogroup" aria-label="投稿する日時">
      <button type="button" className="choice" role="radio" aria-checked={mode === "slot"} disabled={busy} onClick={() => setMode("slot")}>
        <span className="choice-title">次の空き枠へ</span>
        <span className="choice-note">{mode !== "slot" ? "設定した投稿時刻へ、順番に入れます" : slot.isPending ? "空き枠を探しています…" : slot.isError ? "空き枠を取得できませんでした" : slot.data ? `${mdhm(slot.data.at, tz)} ・ ${slot.data.reason}` : "空き枠がありません"}</span>
      </button>
      {mode === "slot" && slot.isError && <p className="msg msg-warn" role="alert">{slot.error instanceof ApiError ? slot.error.message : "「下書き・予約」で投稿スロットを確認してください。"}</p>}
      <button type="button" className="choice" role="radio" aria-checked={mode === "at"} disabled={busy} onClick={() => setMode("at")}>
        <span className="choice-title">日時を指定</span><span className="choice-note">{tz} の時刻で指定します</span>
      </button>
      {mode === "at" && <><input type="datetime-local" className="input" aria-label="投稿する日時" value={local} disabled={busy} onChange={e => setLocal(e.target.value)} />{invalidDate && <p className="muted" role="status">これからの日時を指定してください。</p>}</>}
      <button type="button" className="choice" role="radio" aria-checked={mode === "now"} disabled={busy} onClick={() => setMode("now")}>
        <span className="choice-title">今すぐ</span><span className="choice-note">保存後、サーバーの次の実行で投稿します</span>
      </button>
    </div>
    <button type="button" className="btn section" disabled={busy || !ready} onClick={confirm}>{busy ? "送っています…" : mode === "now" ? "今すぐ投稿する" : mode === "slot" ? "次の空き枠に入れる" : confirmLabel}</button>
    {mode === "slot" && slot.data && !slot.isError && <p className="muted section">保存する時点の空き枠に入ります。他の投稿が先に入った場合は、その次の枠を使います。</p>}
    {mode === "at" && !invalidDate && atIso && <p className="muted section">{mdhm(atIso, tz)} に出します</p>}
  </Sheet>;
}

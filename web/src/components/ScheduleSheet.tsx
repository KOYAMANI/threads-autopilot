/**
 * 日時の決め方を選ぶシート（SPEC §12.3 の Queue「日時変更」と Create「キューに入れる」で共用）。
 *
 * 3経路（SPEC §13 M4 の完了条件）:
 *   今すぐ     … `scheduled_at = now`。すぐ publish ジョブが積まれる
 *   日時指定   … `datetime-local` をアカウントの timezone の壁時計として読む
 *   おすすめ枠 … `GET /queue/suggest-slot`（SPEC §9.3）。理由と本数をそのまま出す
 *
 * シートの物理は `components/Sheet.tsx`（apple-design §2〜§9）に任せる。
 */
import { useEffect, useState } from "react";
import type { SuggestSlotResponse } from "@tap/shared";
import { useSuggestSlot } from "../api/queue";
import { fromDateTimeLocal, mdhm, toDateTimeLocal } from "../lib/format";
import Sheet from "./Sheet";

export type SchedulePick = { kind: "now" | "at"; at: string | null };

export default function ScheduleSheet({
  open,
  onClose,
  onPick,
  accountId,
  tz,
  title = "いつ出す？",
  confirmLabel = "予約する",
  initialAt = null,
  busy = false,
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
  const [mode, setMode] = useState<"now" | "at" | "slot">("now");
  const [local, setLocal] = useState("");
  const slot = useSuggestSlot(accountId, open && mode === "slot");

  // 開くたびに初期値へ戻す（前回の選択が残っていると誤爆する）
  useEffect(() => {
    if (!open) return;
    setMode(initialAt ? "at" : "now");
    setLocal(toDateTimeLocal(initialAt ?? Date.now() + 3600_000, tz));
  }, [open, initialAt, tz]);

  const suggestion: SuggestSlotResponse | undefined = slot.data;
  const atIso = mode === "at" ? fromDateTimeLocal(local, tz) : (suggestion?.at ?? null);
  const ready = mode === "now" || Boolean(atIso);

  function confirm() {
    if (mode === "now") {
      onPick({ kind: "now", at: null });
      return;
    }
    if (!atIso) return;
    onPick({ kind: "at", at: atIso });
  }

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="choices" role="radiogroup" aria-label="投稿する日時">
        <button
          type="button"
          className="choice"
          role="radio"
          aria-checked={mode === "now"}
          onClick={() => setMode("now")}
        >
          <span className="choice-title">今すぐ</span>
          <span className="choice-note">次の5分の実行で出ます</span>
        </button>

        <button
          type="button"
          className="choice"
          role="radio"
          aria-checked={mode === "at"}
          onClick={() => setMode("at")}
        >
          <span className="choice-title">日時を指定</span>
          <span className="choice-note">{tz} の時刻で指定します</span>
        </button>

        {mode === "at" && (
          <input
            type="datetime-local"
            className="input"
            aria-label="投稿する日時"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
          />
        )}

        <button
          type="button"
          className="choice"
          role="radio"
          aria-checked={mode === "slot"}
          onClick={() => setMode("slot")}
        >
          <span className="choice-title">おすすめの枠</span>
          <span className="choice-note">
            {mode !== "slot"
              ? "これまでの実績から空いている枠を選びます"
              : slot.isPending
                ? "枠を探しています…"
                : suggestion
                  ? `${mdhm(suggestion.at, tz)} ・ ${suggestion.reason}`
                  : "枠を出せませんでした"}
          </span>
        </button>
      </div>

      <button
        type="button"
        className="btn"
        style={{ marginTop: "calc(var(--sp) * 2)" }}
        disabled={busy || !ready}
        onClick={confirm}
      >
        {busy ? "送っています…" : mode === "now" ? "今すぐ投稿する" : confirmLabel}
      </button>

      {mode !== "now" && atIso && (
        <p className="muted" style={{ marginTop: "var(--sp)", textAlign: "center" }}>
          {mdhm(atIso, tz)} に出します
        </p>
      )}
    </Sheet>
  );
}

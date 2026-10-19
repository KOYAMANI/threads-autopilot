/**
 * 「AIで直す」のシート（DECISIONS 2026-10-19 4回目）。
 *
 * すぐ使える4つの言い方は押したらそのまま直す。自分で指示するなら書いて「この指示で直す」。
 * 直し終わったら呼び出し側がシートを閉じ、本文を置き換える。
 */
import Sheet from "./Sheet";

export default function ReviseSheet({
  open,
  onClose,
  quick,
  value,
  onValue,
  onRun,
  busy,
  rounds = 0,
}: {
  open: boolean;
  onClose: () => void;
  /** [見せる言葉, AI に渡す指示] */
  quick: Array<[string, string]>;
  value: string;
  onValue: (v: string) => void;
  onRun: (instruction: string) => void;
  busy: boolean;
  /** これまでに直した回数（会話履歴の数） */
  rounds?: number;
}) {
  const empty = value.trim() === "";
  return (
    <Sheet open={open} onClose={onClose} title="AIで直す">
      <div className="revise-sheet">
        <p className="muted">押すと本文が置き換わります。{rounds > 0 ? `（${rounds}回直しました）` : ""}</p>
        <div className="chips revise-chips" role="group" aria-label="すぐ使える直し方">
          {quick.map(([label, text]) => (
            <button key={label} type="button" className="chip" disabled={busy} onClick={() => onRun(text)}>
              {label}
            </button>
          ))}
        </div>
        <label className="field" htmlFor="revise-text">
          <span className="visually-hidden">自分で指示する</span>
          <textarea
            id="revise-text"
            className="input"
            rows={3}
            value={value}
            placeholder="自分で指示する。例: 2つ目の続きに具体例を1つ足す"
            onChange={(e) => onValue(e.target.value)}
          />
        </label>
        <div className="sheet-row">
          <button type="button" className="btn btn-sub" onClick={onClose}>
            やめる
          </button>
          <button
            type="button"
            className="btn"
            aria-busy={busy}
            disabled={busy || empty}
            onClick={() => onRun(value.trim())}
          >
            {busy ? "直しています…" : "この指示で直す"}
          </button>
        </div>
        {!busy && empty && <p className="btn-hint sheet-hint">上の言い方を押すか、指示を書くと押せます。</p>}
      </div>
    </Sheet>
  );
}

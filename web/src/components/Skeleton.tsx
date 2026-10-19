/**
 * 読み込み中の仮置き。中身と同じ形の灰色の帯を出し、表示が来ても画面が跳ねないようにする。
 * 動きは opacity だけ（SPEC §12.5）。reduced-motion では止める（workspace.css）。
 */
export default function Skeleton({ lines = 3, label = "読み込んでいます" }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton-line" style={{ width: i === lines - 1 ? "60%" : "100%" }} />
      ))}
    </div>
  );
}

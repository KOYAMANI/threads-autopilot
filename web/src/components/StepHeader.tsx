/**
 * 作る画面の手順の上の帯（DECISIONS 2026-10-19 4回目）。
 *
 * 「←」（戻る）と見出しだけ。手順の途中なら右に「2/4」を小さく添える。
 * 最初の画面には戻る先がないので、ボタンの代わりに同じ幅の空きを置く（見出しの位置をそろえる）。
 */
export default function StepHeader({
  title,
  onBack,
  progress,
}: {
  title: string;
  /** なければ戻るボタンを出さない */
  onBack?: () => void;
  /** 例: "2/4" */
  progress?: string;
}) {
  return (
    <header className="step-header">
      {onBack ? (
        <button type="button" className="icon-btn step-back" aria-label="戻る" onClick={onBack}>
          <span aria-hidden="true">←</span>
        </button>
      ) : (
        <span className="step-back-space" aria-hidden="true" />
      )}
      <strong>{title}</strong>
      {progress && <span className="step-progress num">{progress}</span>}
    </header>
  );
}

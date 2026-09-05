/**
 * M6〜M7 で作る画面の受け口（SPEC §13）。
 * タブから遷移できて、何がいつ来るかが分かる状態にしておく。
 * Create（M4 で最小フォーム）と Queue（M4）は本実装に移した。
 */

function Stub({ title, lead, note }: { title: string; lead: string; note: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="muted" style={{ marginTop: "0.125rem" }}>
        {lead}
      </p>
      <div className="card section">
        <p className="muted">{note}</p>
      </div>
    </>
  );
}

export function Autopilot() {
  return (
    <Stub
      title="オートパイロット"
      lead="頻度・時間帯・ネタ源・承認方式の設定（M6）"
      note="採点と学習（型別・枠別の集計）、承認/取消のメール導線は M6 で作ります。"
    />
  );
}

export function Settings() {
  return (
    <Stub
      title="設定"
      lead="アカウント・AIキー・通知・リンク・ライセンス（M5 / M7）"
      note="AIキー（BYOK）は M5、診断・書き出し・退会は M7 で作ります。"
    />
  );
}

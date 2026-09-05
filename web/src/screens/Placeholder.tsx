/**
 * M4〜M7 で作る画面の受け口（SPEC §13）。
 * タブから遷移できて、何がいつ来るかが分かる状態にしておく。
 *
 * Create は「リライト／これを型にして作る」から `location.state.preset` を受け取る
 * （SPEC §12.3）。M5 の実装まで、受け取れていることをここで見せる。
 */
import { useLocation } from "react-router-dom";
import type { CreatePreset } from "./Home";

export function Create() {
  const location = useLocation();
  const preset = (location.state as { preset?: CreatePreset } | null)?.preset ?? null;

  return (
    <>
      <h1>作る</h1>
      <p className="muted" style={{ marginTop: "0.125rem" }}>
        自分の投稿と参考情報から3案を作ります（M5）
      </p>

      {preset && (
        <div className="card section">
          <h2>{preset.mode === "rewrite" ? "リライト元" : "文体の見本"}</h2>
          <p className="muted" style={{ marginTop: "0.25rem" }}>
            ホームから受け取りました（投稿ID {preset.postId}）
          </p>
          <p style={{ marginTop: "var(--sp)", fontSize: "0.8125rem", whiteSpace: "pre-wrap" }}>
            {preset.text}
          </p>
        </div>
      )}

      <div className="card section">
        <p className="muted">
          箱1（自分の投稿）・箱2（参考情報）・指示・3案の生成は M5 で作ります。
        </p>
      </div>
    </>
  );
}

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

export function Queue() {
  return (
    <Stub
      title="キュー"
      lead="予約・下書き・投稿済・失敗の管理（M4）"
      note="ツリー投稿・画像・リポストの投稿処理は M4 で作ります。"
    />
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

/**
 * 設定の「Claude と連携」カード（DECISIONS「Claude 連携」）。Settings の「接続とAI」タブに差し込むだけ。
 * コネクタに貼る URL（`<origin>/mcp`）のコピーと、claude.ai 側の3ステップを出す。
 */
import { ApiError } from "../api/client";
import { useClaudeConnection, useDisconnectClaude } from "../api/claude";
import { useToast } from "./Toast";
import "../styles/claude.css";

export default function ClaudeConnectCard() {
  const status = useClaudeConnection();
  const disconnect = useDisconnectClaude();
  const toast = useToast();
  const data = status.data;

  async function copy() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.mcpUrl);
      toast.show("URL をコピーしました", "ok");
    } catch {
      toast.show("コピーできませんでした。URL を長押しして選んでください", "bad");
    }
  }

  return (
    <section className="card section">
      <div className="section-head">
        <h2>Claude と連携</h2>
        {data?.connected && <span className="muted">接続済み</span>}
      </div>
      <p className="muted section">
        ご自身の Claude（claude.ai）のプランで、「作る」画面の3案づくりと直しができます。AIキーは要りません。オートパイロットは今までどおり登録したAIキーで動きます。
      </p>
      {status.isPending && <p className="muted section">連携状態を確認しています…</p>}
      {status.isError && <p className="msg msg-bad section">連携状態を取得できませんでした。</p>}
      {data && !data.configured && <p className="msg msg-warn section">Claude 連携は管理者による設定待ちです。</p>}
      {data?.configured && (
        <>
          <label className="field section" htmlFor="claude-mcp-url">
            <span>コネクタの URL</span>
            <span className="claude-url">
              <input id="claude-mcp-url" className="input" readOnly value={data.mcpUrl} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn btn-sub btn-fit" onClick={copy}>コピー</button>
            </span>
          </label>
          <ol className="steps section">
            <li><span>claude.ai の「設定」→「コネクタ」で「カスタムコネクタを追加」を押し、名前（例: Threads オートパイロット）と上の URL を入れて追加します。</span></li>
            <li><span>追加したコネクタの「接続」を押し、開いた画面で「許可する」を押します。このブラウザでアプリにログインしたまま行ってください。</span></li>
            <li><span>「作る」画面で材料を選んで「Claude で作る」を押し、開いた claude.ai で「作って」と送ります。案はアプリの画面に届きます。</span></li>
          </ol>
          <p className="muted section">Free プランで追加できるカスタムコネクタは1つまでです。Team・Enterprise では組織の管理者が追加します。</p>
          {data.connected && (
            <button
              type="button"
              className="btn btn-sub danger section"
              disabled={disconnect.isPending}
              onClick={() => {
                if (!window.confirm("Claude との連携を解除しますか？claude.ai からこのアプリを使えなくなります。")) return;
                disconnect.mutate(undefined, {
                  onSuccess: () => toast.show("連携を解除しました", "ok"),
                  onError: (e) => toast.show(e instanceof ApiError ? e.message : "解除できませんでした", "bad"),
                });
              }}
            >
              連携を解除
            </button>
          )}
        </>
      )}
    </section>
  );
}

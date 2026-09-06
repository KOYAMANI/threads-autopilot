/**
 * 設定（SPEC §12.3 Settings）。M5 では **AIキー（BYOK）の部分だけ**を作る。
 * アカウント管理・通知・リンク・診断・書き出し・退会は M7。
 *
 * 「キーをこの端末にだけ保存」を **ONにしようとした時点で、保存前に確認を出す**
 * （SPEC §12.3 / DECISIONS の M3「トーストでの事後通知にしない」）:
 *   「この端末にだけ保存すると、オートパイロットは使えません…それでもよろしいですか？」
 * OK なら `localStorage.aiKey` に置き、サーバーには `storeOnServer=false` を送る。
 */
import { useEffect, useState } from "react";
import type { AiProvider } from "@tap/shared";
import { AI_DEFAULT_MODEL } from "@tap/shared";
import { useAccounts } from "../api/accounts";
import {
  readClientKey,
  useAiSettings,
  useSaveAiSettings,
  useTestAi,
  writeClientKey,
} from "../api/ai";
import { ApiError } from "../api/client";
import Sheet from "../components/Sheet";
import { useToast } from "../components/Toast";

const PROVIDERS: Array<{ key: AiProvider; label: string; note: string }> = [
  { key: "gemini", label: "Gemini", note: "無料枠あり。YouTube の動画をそのまま読めます" },
  { key: "openrouter", label: "OpenRouter", note: "モデルを選べます。動画は読めません" },
];

export default function Settings() {
  const toast = useToast();
  const settings = useAiSettings();
  const save = useSaveAiSettings();
  const test = useTestAi();
  const accounts = useAccounts();

  const [provider, setProvider] = useState<AiProvider>("gemini");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [storeOnServer, setStoreOnServer] = useState(true);
  const [confirmLocal, setConfirmLocal] = useState(false);

  // サーバーの状態を初期値にする（キー本体は返ってこない）
  useEffect(() => {
    const s = settings.data;
    if (!s) return;
    if (s.provider) setProvider(s.provider);
    setModel(s.model ?? "");
    setStoreOnServer(s.storeOnServer);
  }, [settings.data]);

  const s = settings.data;
  const hasClientKey = readClientKey() !== null;
  const apOn = (accounts.data ?? []).filter((a) => a.autopilotEnabled);

  function fail(e: unknown, fallback: string) {
    toast.show(e instanceof ApiError ? e.message : fallback, "bad");
  }

  function commit(nextStoreOnServer: boolean) {
    const trimmed = key.trim();
    if (!nextStoreOnServer && trimmed === "" && !hasClientKey) {
      toast.show("この端末に保存するキーを入力してください", "bad");
      return;
    }
    save.mutate(
      {
        provider,
        model: model.trim() === "" ? undefined : model.trim(),
        // 端末保存のときはサーバーへキーを送らない
        key: nextStoreOnServer && trimmed !== "" ? trimmed : undefined,
        storeOnServer: nextStoreOnServer,
      },
      {
        onSuccess: () => {
          // 端末保存にしたときだけ localStorage に置く。サーバー保存に戻したら消す
          if (nextStoreOnServer) writeClientKey(null);
          else if (trimmed !== "") writeClientKey(trimmed);
          setKey("");
          setStoreOnServer(nextStoreOnServer);
          setConfirmLocal(false);
          toast.show("保存しました", "ok");
        },
        onError: (e) => fail(e, "保存できませんでした"),
      },
    );
  }

  /** ONにしようとした時点で確認を出す（SPEC §12.3。事後のトーストにしない） */
  function onToggleLocal(next: boolean) {
    if (next) {
      setConfirmLocal(true);
      return;
    }
    setStoreOnServer(true);
  }

  function runTest() {
    const clientKey = storeOnServer ? undefined : (key.trim() || readClientKey() || undefined);
    test.mutate(
      { clientKey },
      {
        onSuccess: (r) => toast.show(`つながりました（${r.model} / ${r.latencyMs}ms）`, "ok"),
        onError: (e) => fail(e, "つながりませんでした"),
      },
    );
  }

  return (
    <>
      <h1>設定</h1>
      <p className="muted" style={{ marginTop: "0.125rem" }}>
        AIキー（買い手のキーで動きます）
      </p>

      <section className="card section">
        <h2>AIのプロバイダ</h2>
        <div className="choices" style={{ marginTop: "var(--sp)" }}>
          {PROVIDERS.map((p) => (
            <button
              key={p.key}
              type="button"
              className="choice"
              role="radio"
              aria-checked={provider === p.key}
              onClick={() => {
                setProvider(p.key);
                setModel(AI_DEFAULT_MODEL[p.key]);
              }}
            >
              <span className="choice-title">{p.label}</span>
              <span className="choice-note">{p.note}</span>
            </button>
          ))}
        </div>

        <label className="field" htmlFor="ai-model">
          <span>モデル</span>
          <input
            id="ai-model"
            className="input"
            value={model}
            placeholder={AI_DEFAULT_MODEL[provider]}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>

        <label className="field" htmlFor="ai-key">
          <span>APIキー</span>
          <input
            id="ai-key"
            className="input"
            type="password"
            autoComplete="off"
            value={key}
            placeholder={
              s?.hasKey
                ? "登録済み。変えるときだけ入力してください"
                : hasClientKey && s && !s.storeOnServer
                  ? "この端末に保存済み。変えるときだけ入力してください"
                  : "貼り付けてください"
            }
            onChange={(e) => setKey(e.target.value)}
          />
        </label>

        <p className="muted section">
          {s?.hasKey
            ? "いまはサーバーに保存しています。オートパイロットが使えます。"
            : s && !s.storeOnServer
              ? "いまはこの端末にだけ保存しています。オートパイロットは使えません。"
              : "まだキーがありません。"}
        </p>

        <div className="choices section">
          <button
            type="button"
            className="choice"
            role="switch"
            aria-checked={!storeOnServer}
            onClick={() => onToggleLocal(storeOnServer)}
          >
            <span className="choice-title">キーをこの端末にだけ保存</span>
            <span className="choice-note">
              サーバーに預けません。かわりにオートパイロットは使えません
            </span>
          </button>
        </div>

        <div className="section" style={{ display: "grid", gap: "calc(var(--sp) * 1.5)" }}>
          <button
            type="button"
            className="btn"
            disabled={save.isPending}
            onClick={() => commit(storeOnServer)}
          >
            {save.isPending ? "保存しています…" : "保存する"}
          </button>
          <button
            type="button"
            className="btn btn-sub"
            disabled={test.isPending}
            onClick={runTest}
          >
            {test.isPending ? "試しています…" : "つながるか試す"}
          </button>
        </div>
      </section>

      <section className="card section">
        <p className="muted">
          アカウント管理・通知・リンク・診断・書き出し・退会は M7 で作ります。
        </p>
      </section>

      <Sheet
        open={confirmLocal}
        onClose={() => setConfirmLocal(false)}
        title="この端末にだけ保存しますか？"
      >
        <p>
          この端末にだけ保存すると、オートパイロットは使えません（サーバーが自動生成のときにキーを読めないため）。それでもよろしいですか？
        </p>
        {apOn.length > 0 && (
          <p className="msg msg-warn section" role="status">
            いまオートパイロットがONのアカウント: {apOn.map((a) => `@${a.username}`).join("、")}
          </p>
        )}
        <div className="section" style={{ display: "grid", gap: "calc(var(--sp) * 1.5)" }}>
          <button
            type="button"
            className="btn"
            disabled={save.isPending}
            onClick={() => commit(false)}
          >
            この端末にだけ保存する
          </button>
          <button type="button" className="btn btn-sub" onClick={() => setConfirmLocal(false)}>
            やめる
          </button>
        </div>
      </Sheet>
    </>
  );
}

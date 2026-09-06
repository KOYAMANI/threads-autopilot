/**
 * 箱2: 参考情報（design-v0.2 §3-4 / SPEC §12.3 Create / §10.4）。
 *
 * 入口は4つ。ためたものは**プール**として残り、オートパイロットのネタ源にもなる:
 *   テキスト貼付 … そのまま `content`
 *   YouTube URL … サーバーで正規化してタイトルだけ取る。本文は取らない
 *   ファイル     … .txt / .md を**ブラウザで読んで** `content` として送る（2MB まで、SPEC §10.4）
 *   記事URL     … サーバーで本文を抽出（失敗したら「本文を貼ってください」）
 */
import { useRef, useState } from "react";
import type { SourceSummary, SourceType } from "@tap/shared";
import { ApiError } from "../api/client";
import { useCreateSource, useDeleteSource, useSources } from "../api/ai";
import { useToast } from "./Toast";

/** ファイルの上限（SPEC §10.4）。 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const TYPE_LABEL: Record<SourceType, string> = {
  text: "テキスト",
  youtube: "YouTube",
  file: "ファイル",
  url: "記事",
};

const ADDERS: Array<{ type: SourceType; label: string }> = [
  { type: "text", label: "＋テキスト貼付" },
  { type: "youtube", label: "＋YouTube URL" },
  { type: "file", label: "＋ファイル" },
  { type: "url", label: "＋記事URL" },
];

export default function SourceAdder({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toast = useToast();
  const sources = useSources();
  const create = useCreateSource();
  const remove = useDeleteSource();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [adding, setAdding] = useState<SourceType | null>(null);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");

  const list: SourceSummary[] = sources.data ?? [];

  function fail(e: unknown, fallback: string) {
    toast.show(e instanceof ApiError ? e.message : fallback, "bad");
  }

  function added(id: string, label: string) {
    onChange([...selected, id]);
    setAdding(null);
    setText("");
    setUrl("");
    toast.show(`${label}を追加しました`, "ok");
  }

  function submitText() {
    if (text.trim() === "") return;
    create.mutate(
      { type: "text", content: text },
      {
        onSuccess: (r) => added(r.source.id, "テキスト"),
        onError: (e) => fail(e, "追加できませんでした"),
      },
    );
  }

  function submitUrl(type: "youtube" | "url") {
    if (url.trim() === "") return;
    create.mutate(
      { type, url },
      {
        onSuccess: (r) => added(r.source.id, TYPE_LABEL[type]),
        onError: (e) => fail(e, "追加できませんでした"),
      },
    );
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast.show("ファイルは2MBまでです", "bad");
      return;
    }
    if (!/\.(txt|md)$/i.test(file.name)) {
      toast.show(".txt か .md を選んでください", "bad");
      return;
    }
    let content = "";
    try {
      content = await file.text();
    } catch {
      toast.show("ファイルを読めませんでした", "bad");
      return;
    }
    create.mutate(
      { type: "file", title: file.name, content },
      {
        onSuccess: (r) => added(r.source.id, "ファイル"),
        onError: (e) => fail(e, "追加できませんでした"),
      },
    );
  }

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  }

  return (
    <section className="card section">
      <div className="section-head">
        <h2>参考情報</h2>
        <span className="muted">{selected.length > 0 ? `${selected.length}件を使う` : "任意"}</span>
      </div>

      <div className="chips" style={{ marginTop: "var(--sp)" }}>
        {ADDERS.map((a) => (
          <button
            key={a.type}
            type="button"
            className="chip"
            aria-pressed={adding === a.type}
            disabled={create.isPending}
            onClick={() => {
              if (a.type === "file") {
                fileRef.current?.click();
                return;
              }
              setAdding(adding === a.type ? null : a.type);
            }}
          >
            {a.label}
          </button>
        ))}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".txt,.md,text/plain,text/markdown"
        hidden
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {adding === "text" && (
        <>
          <label className="field" htmlFor="src-text">
            <span>貼り付ける本文</span>
            <textarea
              id="src-text"
              className="input"
              rows={5}
              autoFocus
              value={text}
              placeholder="記事や台本をそのまま貼ってください。"
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn section"
            disabled={create.isPending || text.trim() === ""}
            onClick={submitText}
          >
            {create.isPending ? "追加しています…" : "追加する"}
          </button>
        </>
      )}

      {(adding === "youtube" || adding === "url") && (
        <>
          <label className="field" htmlFor="src-url">
            <span>{adding === "youtube" ? "YouTube のURL" : "記事のURL"}</span>
            <input
              id="src-url"
              className="input"
              autoFocus
              value={url}
              placeholder="https://"
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <p className="muted" style={{ marginTop: "calc(var(--sp) * 0.5)" }}>
            {adding === "youtube"
              ? "Gemini なら動画をそのまま読みます。OpenRouter のときは文字起こしを貼ってください。"
              : "本文をこちらで取り出します。取れなかったら本文を貼ってください。"}
          </p>
          <button
            type="button"
            className="btn section"
            disabled={create.isPending || url.trim() === ""}
            onClick={() => submitUrl(adding)}
          >
            {create.isPending ? "読み込んでいます…" : "追加する"}
          </button>
        </>
      )}

      {list.length === 0 && !sources.isPending && (
        <p className="muted section">まだ参考情報がありません。上のボタンから足してください。</p>
      )}

      <div className="choices section">
        {list.map((s) => (
          <div key={s.id} style={{ display: "flex", gap: "var(--sp)", alignItems: "stretch" }}>
            <button
              type="button"
              className="choice"
              role="checkbox"
              aria-checked={selected.includes(s.id)}
              onClick={() => toggle(s.id)}
            >
              <span className="choice-title">{s.title}</span>
              <span className="choice-note">
                {TYPE_LABEL[s.type]} ・ {s.charCount > 0 ? `${s.charCount}文字` : "本文なし"}
                {s.useCount > 0 ? ` ・ ${s.useCount}回使用` : ""}
              </span>
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`${s.title} を消す`}
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(s.id, {
                  onSuccess: () => onChange(selected.filter((x) => x !== s.id)),
                  onError: (e) => fail(e, "消せませんでした"),
                })
              }
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

import { useEffect, useRef, useState } from "react";
import type { AiHistoryTurn } from "@tap/shared";

export default function GenerationChat({messages, busy, onContinue}: {
  messages: AiHistoryTurn[];
  busy: boolean;
  onContinue: (answer: string, delegate: boolean) => void;
}) {
  const [answer, setAnswer] = useState("");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (messages.at(-1)?.role === "assistant") setAnswer(""); }, [messages]);
  useEffect(() => { end.current?.scrollIntoView({block:"nearest", behavior:"smooth"}); }, [messages.length, busy]);
  return <section className="generation-chat section" aria-label="AIと投稿を相談">
    <div className="generation-chat-heading"><strong>投稿の方向性を決めましょう</strong><span className="muted">答えても、おまかせでも大丈夫です</span></div>
    <div className="generation-chat-log" role="log" aria-live="polite" aria-relevant="additions text">
      {messages.map((message,index) => <div key={index} className={`generation-message generation-message-${message.role}`}>
        <span className="generation-message-author">{message.role === "assistant" ? "AI" : "あなた"}</span>
        <p>{message.text}</p>
      </div>)}
      {busy && <div className="generation-message generation-message-assistant"><span className="generation-message-author">AI</span><p>内容を受け取って、3案を作っています…</p></div>}
      <div ref={end} />
    </div>
    <form className="generation-chat-composer" onSubmit={event => {event.preventDefault();if (answer.trim() && !busy) onContinue(answer.trim(), false);}}>
      <label htmlFor="generation-answer">補足したいこと</label>
      <textarea id="generation-answer" className="input" value={answer} maxLength={1000} disabled={busy} rows={3} onChange={event => setAnswer(event.target.value)} placeholder="例：忙しい会社員向け。コンビニで買えるものを中心に。" />
      <div className="generation-chat-actions">
        <button type="submit" className="btn" disabled={busy || !answer.trim()}>回答して3案を作る</button>
        <button type="button" className="btn btn-sub" disabled={busy} onClick={() => onContinue(answer.trim(), true)}>全部任せて3案を作る</button>
      </div>
      <p className="muted">おまかせでは読者や切り口をAIが決めます。入力した補足も使います。実績や体験談は作りません。</p>
    </form>
  </section>;
}

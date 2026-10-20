/**
 * 3案を左右にスライドして1つずつ見るカルーセル（DECISIONS 2026-10-19 4回目）。
 *
 * - 横スクロール＋scroll-snap。指の動きはブラウザのスクロールがそのまま受け持つ（1:1・慣性・中断可能）
 * - 下に A・B・C の点。押すとその案まで送る。PC では「← 前の案」「次の案 →」も出す（CSS で出し分け）
 * - いま見えている案はスクロール位置から求めて `onIndex` で返す
 * - 中身は本文と続きの全文だけ。根拠・分析は出さない
 * - reduced-motion では送るときに滑らせない
 */
import { useEffect, useRef } from "react";
import type { AccountSummary, AiCandidate } from "@tap/shared";
import AccountAvatar from "./AccountAvatar";
import { useReducedMotion } from "../lib/motion";

export default function CandidateCarousel({
  candidates,
  account,
  index,
  onIndex,
}: {
  candidates: AiCandidate[];
  account: AccountSummary;
  index: number;
  onIndex: (i: number) => void;
}) {
  const reduced = useReducedMotion();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const indexRef = useRef(index);
  indexRef.current = index;

  function step(): number {
    const track = trackRef.current;
    const first = track?.firstElementChild as HTMLElement | null;
    if (!track || !first) return 0;
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    return first.offsetWidth + gap;
  }

  function jump(i: number, smooth = true) {
    const track = trackRef.current;
    if (!track) return;
    const next = Math.max(0, Math.min(candidates.length - 1, i));
    track.scrollTo({ left: next * step(), behavior: smooth && !reduced ? "smooth" : "auto" });
    if (next !== indexRef.current) onIndex(next);
  }

  // 戻ってきたときは、前に見ていた案から始める（滑らせない）
  useEffect(() => {
    jump(indexRef.current, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const w = step();
        if (!w) return;
        const i = Math.max(0, Math.min(candidates.length - 1, Math.round(track.scrollLeft / w)));
        if (i !== indexRef.current) onIndex(i);
      });
    };
    track.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      track.removeEventListener("scroll", onScroll);
    };
  }, [candidates.length, onIndex]);

  return (
    <div className="carousel-wrap">
      <div className="carousel-arrows">
        <button type="button" className="btn btn-sub btn-fit" disabled={index === 0} onClick={() => jump(index - 1)}>
          ← 前の投稿
        </button>
        <button
          type="button"
          className="btn btn-sub btn-fit"
          disabled={index >= candidates.length - 1}
          onClick={() => jump(index + 1)}
        >
          次の投稿 →
        </button>
      </div>
      <div
        ref={trackRef}
        className="carousel"
        role="group"
        aria-roledescription="カルーセル"
        aria-label="できた投稿"
      >
        {candidates.map((c, i) => (
          <article
            key={c.key}
            className="carousel-card"
            aria-roledescription="スライド"
            aria-label={`投稿${c.key}（${i + 1}/${candidates.length}）`}
          >
            <div className="carousel-card-head">
              <strong>投稿{c.key}</strong>
              {(c.angle ?? c.hook) && <span>{c.angle ?? c.hook}</span>}
            </div>
            <ol className="viewer-thread carousel-thread">
              {[c.body, ...c.comments.filter((t) => t.trim() !== "")].map((text, j) => (
                <li key={j} className="viewer-post">
                  <div className="viewer-rail" aria-hidden="true">
                    <AccountAvatar account={account} />
                  </div>
                  <div className="viewer-body">
                    <div className="viewer-head">
                      <strong>@{account.username}</strong>
                      {j > 0 && <span className="muted">続き {j}</span>}
                    </div>
                    <p className="viewer-text">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </article>
        ))}
      </div>
      <div className="carousel-dots" role="group" aria-label="投稿を選ぶ">
        {candidates.map((c, i) => (
          <button
            key={c.key}
            type="button"
            aria-pressed={i === index}
            aria-label={`投稿${c.key}`}
            onClick={() => jump(i)}
          >
            {c.key}
          </button>
        ))}
      </div>
    </div>
  );
}

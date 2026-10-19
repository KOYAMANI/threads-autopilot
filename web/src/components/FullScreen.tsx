/**
 * 全画面の入れ物（投稿の全画面ビューと、スマホの AI パネルで共通）。
 *
 * 上の帯（閉じる・見出し・右端の操作）、中だけスクロールする本体、下の帯。
 * 開いている間は後ろをスクロールさせず、閉じたら開く前のフォーカスに戻す。
 * 動きは transform と opacity だけ（SPEC §12.5）。reduced-motion では opacity だけ。
 */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CloseIcon } from "./Icons";
import { CROSSFADE, SPRING, useReducedMotion } from "../lib/motion";

export default function FullScreen({
  open,
  onClose,
  title,
  headerActions,
  footer,
  escapeDisabled = false,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** 上の帯の右端（主役でない操作） */
  headerActions?: ReactNode;
  footer?: ReactNode;
  /** 上にシートが重なっている間は Esc をシートに譲る */
  escapeDisabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // 閉じるボタンではなくダイアログ自体に置く（タップで開いたのに枠が出ないように）
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      back?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open || escapeDisabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, escapeDisabled, onClose]);

  // Sheet と同じく木の中に置く（シートが上に重なる順序を z-index だけで決めるため）
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={dialogRef}
          tabIndex={-1}
          className={className ? `viewer ${className}` : "viewer"}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: 24 }}
          transition={reduced ? CROSSFADE : SPRING}
        >
          <header className="viewer-bar">
            <button type="button" className="icon-btn" aria-label="閉じる" onClick={onClose}>
              <CloseIcon size={20} />
            </button>
            <strong>{title}</strong>
            {headerActions && <div className="viewer-bar-actions">{headerActions}</div>}
          </header>
          <div className="viewer-scroll">{children}</div>
          {footer && <footer className="viewer-actions">{footer}</footer>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * 下からのシート（SPEC §12.5、apple-design §2〜§9）。Drawer と同じ物理で縦に動く。
 *
 * - 指と1:1で追従。動いている最中に掴んでも現在位置から続く
 * - 離した速度から到達点を投影し、その最寄り（開く / 閉じる）へ倒す
 * - 上限（開ききった位置）より上へ引くとラバーバンドで抵抗する
 * - reduced-motion では transform を動かさず opacity だけ
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useDragControls } from "motion/react";
import type { PanInfo } from "motion/react";
import { CROSSFADE, SPRING_GESTURE, flickWith, project, useReducedMotion } from "../lib/motion";

const CLOSE_RATIO = 0.4;

export default function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const reduced = useReducedMotion();
  const dragControls = useDragControls();
  const y = useMotionValue(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // 弾いて閉じたときだけ、離した速度を退場の spring に渡す（SPEC §12.5）
  const [exitVelocity, setExitVelocity] = useState<number | null>(null);

  useEffect(() => {
    if (open) setExitVelocity(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    const timer = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>("button, input, textarea, select")?.focus({ preventScroll: true }));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); }
      if (e.key !== "Tab") return;
      const nodes = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]') ?? [])].filter(x => x.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(timer);
      window.removeEventListener("keydown", onKey);
      if (root) root.inert = wasInert;
      previous?.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const resize = () => {
      const panel = panelRef.current;
      if (!panel) return;
      panel.style.maxHeight = `${Math.max(120, viewport.height - 16)}px`;
      panel.style.bottom = `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`;
    };
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("scroll", resize);
    };
  }, [open]);

  function onDragEnd(_: unknown, info: PanInfo) {
    const height = panelRef.current?.offsetHeight ?? 240;
    const projected = y.get() + project(info.velocity.y);
    if (projected > height * CLOSE_RATIO) {
      setExitVelocity(info.velocity.y);
      onClose();
      return;
    }
    animate(y, 0, flickWith(info.velocity.y));
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            type="button"
            className="scrim"
            aria-label="閉じる"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={CROSSFADE}
          />
          <motion.div
            ref={panelRef}
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            // 中央寄せの translateX(-50%) と共存させるため x も motion 側で持つ
            style={{ y, x: "-50%" }}
            initial={reduced ? { opacity: 0, y: 0 } : { y: "100%" }}
            animate={reduced ? { opacity: 1, y: 0 } : { y: 0 }}
            exit={reduced ? { opacity: 0, y: 0 } : { y: "100%" }}
            transition={
              reduced
                ? CROSSFADE
                : exitVelocity === null
                  ? SPRING_GESTURE
                  : flickWith(exitVelocity)
            }
            drag={reduced ? false : "y"}
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 1000 }}
            dragElastic={{ top: 0.08, bottom: 0 }}
            dragMomentum={false}
            onDragEnd={onDragEnd}
          >
            <div className="sheet-handle" onPointerDown={e => dragControls.start(e)}><div className="sheet-grip" aria-hidden="true" /></div>
            <button type="button" className="sheet-close" aria-label="シートを閉じる" onClick={onClose}>×</button>
            <h2 style={{ padding: "0 0 var(--sp)" }}>{title}</h2>
            {/* 中身が画面より高いときはここだけスクロールさせる（シート自体は動かさない） */}
            <div className="sheet-body">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>, document.body
  );
}

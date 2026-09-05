/**
 * 下からのシート（SPEC §12.5、apple-design §2〜§9）。Drawer と同じ物理で縦に動く。
 *
 * - 指と1:1で追従。動いている最中に掴んでも現在位置から続く
 * - 離した速度から到達点を投影し、その最寄り（開く / 閉じる）へ倒す
 * - 上限（開ききった位置）より上へ引くとラバーバンドで抵抗する
 * - reduced-motion では transform を動かさず opacity だけ
 */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, animate, motion, useMotionValue } from "motion/react";
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
  const reduced = useReducedMotion();
  const y = useMotionValue(0);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function onDragEnd(_: unknown, info: PanInfo) {
    const height = panelRef.current?.offsetHeight ?? 240;
    const projected = y.get() + project(info.velocity.y);
    if (projected > height * CLOSE_RATIO) {
      onClose();
      return;
    }
    animate(y, 0, flickWith(info.velocity.y));
  }

  return (
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
            transition={reduced ? CROSSFADE : SPRING_GESTURE}
            drag={reduced ? false : "y"}
            dragConstraints={{ top: 0, bottom: 1000 }}
            dragElastic={{ top: 0.08, bottom: 0 }}
            dragMomentum={false}
            onDragEnd={onDragEnd}
          >
            <div className="sheet-grip" aria-hidden="true" />
            <h2 style={{ padding: "0 0 var(--sp)" }}>{title}</h2>
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/**
 * 左からのドロワー（SPEC §12.2 / §12.5、apple-design §2〜§9）。
 *
 * - 指と1:1で追従し、動いている最中に掴んでも presentation value から続く（motion の drag）
 * - 離した速度を spring の初速に渡し、行き先は「投影点の最寄り」で決める
 * - 開ききった側（右）はラバーバンドで、硬く止めない
 * - 出入りは同じ経路（左から出て左へ戻る）
 * - reduced-motion では transform を動かさず opacity のクロスフェードだけにする
 */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "motion/react";
import type { PanInfo } from "motion/react";
import { CROSSFADE, SPRING_GESTURE, flickWith, project, useReducedMotion } from "../lib/motion";

/** 掴んだ位置ではなくこの割合を越えたら「閉じる」に倒す（投影点で判定する） */
const CLOSE_RATIO = 0.5;

export default function Drawer({
  open,
  onClose,
  labelledBy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const x = useMotionValue(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const widthRef = useRef(320);

  // 覆いの濃さはドロワーの現在位置に連動させる（ドラッグ中も連続してフィードバックする）
  const scrimOpacity = useTransform(x, [-widthRef.current, 0], [0, 1]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function onDragEnd(_: unknown, info: PanInfo) {
    const width = panelRef.current?.offsetWidth ?? widthRef.current;
    // 離した位置の最寄りではなく、速度から求めた到達点で行き先を決める（apple-design §6）
    const projected = x.get() + project(info.velocity.x);
    if (projected < -width * CLOSE_RATIO) {
      onClose();
      return;
    }
    // 戻すときも離した速度をそのまま継ぐ（速度をハードカットしない。apple-design §5）
    animate(x, 0, flickWith(info.velocity.x));
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.button
            type="button"
            className="scrim"
            aria-label="メニューを閉じる"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={CROSSFADE}
            style={reduced ? undefined : { opacity: scrimOpacity }}
          />
          <motion.div
            ref={panelRef}
            className="drawer"
            role="dialog"
            aria-modal="true"
            {...(labelledBy ? { "aria-labelledby": labelledBy } : {})}
            style={{ x }}
            initial={reduced ? { opacity: 0, x: 0 } : { x: "-100%" }}
            animate={reduced ? { opacity: 1, x: 0 } : { x: 0 }}
            exit={reduced ? { opacity: 0, x: 0 } : { x: "-100%" }}
            transition={reduced ? CROSSFADE : SPRING_GESTURE}
            drag={reduced ? false : "x"}
            dragDirectionLock
            dragConstraints={{ left: -1000, right: 0 }}
            // 右へ引っ張ったぶんは進むほど付いてこない（ラバーバンド）
            dragElastic={{ left: 0, right: 0.08 }}
            dragMomentum={false}
            onDragEnd={onDragEnd}
          >
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

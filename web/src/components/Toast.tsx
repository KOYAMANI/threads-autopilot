/**
 * トースト（SPEC §12.2「失敗はトースト＋画面内メッセージ」）。
 * 出入りは spring（apple-design §4）。reduced-motion では opacity のクロスフェードだけ。
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CROSSFADE, SPRING, useReducedMotion } from "../lib/motion";

export type ToastKind = "info" | "ok" | "bad";
type Toast = { id: number; text: string; kind: ToastKind };

type ToastApi = { show: (text: string, kind?: ToastKind) => void };

const Ctx = createContext<ToastApi>({ show: () => {} });

export function useToast(): ToastApi {
  return useContext(Ctx);
}

const LIFETIME_MS = 4200;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);

  const show = useCallback((text: string, kind: ToastKind = "info") => {
    const id = ++seq.current;
    setItems((prev) => [...prev.slice(-2), { id, text, kind }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), LIFETIME_MS);
  }, []);

  const api = useMemo(() => ({ show }), [show]);
  const reduced = useReducedMotion();

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-wrap" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              className={`toast ${t.kind === "bad" ? "toast-bad" : t.kind === "ok" ? "toast-ok" : ""}`}
              // 出入りは同じ経路（apple-design §7）。下から出て下へ戻す
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
              animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }}
              transition={reduced ? CROSSFADE : SPRING}
              role={t.kind === "bad" ? "alert" : "status"}
            >
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}

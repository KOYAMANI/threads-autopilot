/**
 * spring のプリセットと、ジェスチャーの物理（SPEC §12.5 / apple-design SKILL.md）。
 *
 * 画面から直接数値を書かない。ここに置いた値だけを使う。
 * - 既定（Tabs / Toast / 行展開 / メニュー）: bounce 0（臨界減衰）, duration 0.35
 * - Sheet / Drawer（指で動かすもの）:        bounce 0.2, duration 0.3
 * - 弾いて閉じたとき（勢いがある）:           bounce 0.2, duration 0.4 ＋ 離した速度
 *
 * `prefers-reduced-motion: reduce` のときは spring とスライドをやめ、
 * 200ms の opacity クロスフェードにする（transform は動かさない・オーバーシュート全廃）。
 */
import { useEffect, useState } from "react";
import type { Transition } from "motion/react";

/* `as const satisfies Transition` にしてあるのは、コンポーネントの `transition` 属性と
 * `animate(motionValue, ...)` の第3引数の両方に、そのまま渡せるようにするため。 */

/** 既定。跳ねない。ただ開いただけのメニューはオーバーシュートさせない */
export const SPRING = { type: "spring", bounce: 0, duration: 0.35 } as const satisfies Transition;

/** 指で動かすもの（Drawer / Sheet）。damping ≈ 0.8 / response 0.3 相当 */
export const SPRING_GESTURE = {
  type: "spring",
  bounce: 0.2,
  duration: 0.3,
} as const satisfies Transition;

/** 弾いて閉じたとき。`velocity` を足して使う */
export const SPRING_FLICK = {
  type: "spring",
  bounce: 0.2,
  duration: 0.4,
} as const satisfies Transition;

/** reduced-motion のときの唯一の動き */
export const CROSSFADE = { duration: 0.2, ease: "linear" } as const satisfies Transition;

/** 離した速度を spring の初速に渡す（apple-design §5 の velocity handoff） */
export function flickWith(velocity: number) {
  return { ...SPRING_FLICK, velocity };
}

/**
 * 減速後の到達点（apple-design §6）。離した位置の最寄りではなく、
 * ここで求めた投影点の最寄りのスナップ点へ向かう。
 * `current + project(v)` が投影点。
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/**
 * 境界を越えた分の追従量（apple-design §9）。進むほど付いてこなくなる。
 * @param overshoot 境界を越えた距離（px）
 * @param dimension その方向の寸法（px）
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (dimension <= 0) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

export function useReducedTransparency(): boolean {
  return useMediaQuery("(prefers-reduced-transparency: reduce)");
}

/**
 * 画面に置く transition を1か所で決める。
 * reduced-motion なら常にクロスフェード（オーバーシュートなし）。
 */
export function transitionFor(reduced: boolean, base: Transition = SPRING): Transition {
  return reduced ? CROSSFADE : base;
}

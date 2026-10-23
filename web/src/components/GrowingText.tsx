/**
 * 中身に合わせて高さが伸びる入力欄（Composer の GrowingText と同じ仕組み。長文の下書き用）。
 * 動かすのは高さの即時変更だけで、アニメーションはしない（SPEC §12.5）。
 */
import { useLayoutEffect, useRef } from "react";

export default function GrowingText({
  id,
  value,
  placeholder,
  onChange,
  label,
  className = "input wizard-textarea",
  rows = 4,
  maxLength,
}: {
  id: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  label?: string;
  className?: string;
  rows?: number;
  maxLength?: number;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      id={id}
      ref={ref}
      className={className}
      rows={rows}
      aria-label={label}
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/** Grow with the actual wrapped text, including generated values and viewport changes.
 * Keep the native textarea so selection, IME and mobile editing remain native.
 */
export default function AutoTextarea({ className = "", value, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const resize = () => {
    const element = ref.current;
    if (!element || !element.clientWidth) return;
    element.style.height = "auto";
    const style = getComputedStyle(element);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    element.style.height = `${element.scrollHeight + (style.boxSizing === "border-box" ? border : -parseFloat(style.paddingTop) - parseFloat(style.paddingBottom))}px`;
  };

  useLayoutEffect(resize, [value]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      resize();
    });
    observer.observe(element);
    let mounted = true;
    void document.fonts.ready.then(() => { if (mounted) resize(); });
    return () => { mounted = false; observer.disconnect(); };
  }, []);

  return <textarea {...props} ref={ref} value={value} className={`auto-textarea ${className}`} />;
}

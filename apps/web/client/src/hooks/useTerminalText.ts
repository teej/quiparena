import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Reveal incoming text in small bursts, catching up within 160ms even for a large delta. */
export function useTerminalText(text: string, identity: string): string {
  const [visible, setVisible] = useState(text);
  const buffer = useRef({ target: text, shown: text, identity, deadline: 0 });
  useLayoutEffect(() => {
    const current = buffer.current;
    const now = performance.now();
    if (current.identity !== identity || !text.startsWith(current.shown)) {
      current.shown = "";
      current.identity = identity;
      current.deadline = now + 160;
      setVisible("");
    } else if (current.target === current.shown) {
      current.deadline = now + 160;
    }
    current.target = text;
  }, [text, identity]);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const timer = window.setInterval(() => {
      const current = buffer.current;
      if (current.shown === current.target) return;
      const frames = Math.max(1, Math.ceil((current.deadline - performance.now()) / 32));
      const remaining = Array.from(current.target.slice(current.shown.length));
      current.shown = reducedMotion.matches ? current.target
        : current.shown + remaining.slice(0, Math.max(3, Math.ceil(remaining.length / frames))).join("");
      setVisible(current.shown);
    }, 32);
    return () => window.clearInterval(timer);
  }, []);
  return visible;
}

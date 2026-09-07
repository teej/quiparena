import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TerminalBuffer } from "./terminalBuffer.js";

/** Buffer both streamed deltas and complete responses; reveal three chunks every 24ms. */
export function useTerminalText(text: string, identity: string): string {
  const [visible, setVisible] = useState("");
  const buffer = useRef(new TerminalBuffer());
  useLayoutEffect(() => {
    setVisible(buffer.current.update(text, identity));
  }, [text, identity]);
  useEffect(() => {
    const timer = window.setInterval(() => setVisible(buffer.current.tick()), 24);
    return () => window.clearInterval(timer);
  }, []);
  return visible;
}

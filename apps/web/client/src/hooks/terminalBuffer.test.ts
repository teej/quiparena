import { describe, expect, it } from "vitest";
import { TerminalBuffer, terminalChunks } from "./terminalBuffer.js";

describe("terminal playback buffer", () => {
  it("queues a complete response rather than showing it on arrival or the first tick", () => {
    const buffer = new TerminalBuffer();
    const text = "A complete answer arrives all at once, but should still type out.";
    expect(buffer.update(text, "answer")).toBe("");
    const first = buffer.tick();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(text.length);
    expect(text.startsWith(first)).toBe(true);
    for (let i = 0; i < 100; i++) buffer.tick();
    expect(buffer.tick()).toBe(text);
  });
  it("preserves queued content when new deltas arrive", () => {
    const buffer = new TerminalBuffer();
    buffer.update("Hello ", "answer");
    buffer.update("Hello 🌍!\nSecond line.", "answer");
    buffer.tick();
    buffer.update("Hello 🌍!\nSecond line. More.", "answer");
    for (let i = 0; i < 30; i++) buffer.tick();
    expect(buffer.tick()).toBe("Hello 🌍!\nSecond line. More.");
  });
  it("discards old queued text on a new prompt or revised response", () => {
    const buffer = new TerminalBuffer();
    buffer.update("Old response that has not finished playing", "old");
    buffer.tick();
    expect(buffer.update("New response", "new")).toBe("");
    buffer.tick();
    expect(buffer.update("Revised", "new")).toBe("");
    for (let i = 0; i < 10; i++) buffer.tick();
    expect(buffer.tick()).toBe("Revised");
  });
  it("bounds long unbroken chunks and preserves Unicode and whitespace", () => {
    const text = "abcdefghijklmnopqrstuvwxyz 🌍\n你好世界";
    const chunks = terminalChunks(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every(chunk => Array.from(chunk).length <= 6)).toBe(true);
  });
});

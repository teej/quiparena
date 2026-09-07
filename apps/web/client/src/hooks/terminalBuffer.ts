/** Presentation chunks, not provider tokens. Bound each chunk even for unbroken text. */
export function terminalChunks(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_]{1,6}|[^\s\p{L}\p{N}_]/gu) ?? [];
}

export class TerminalBuffer {
  private target = "";
  private shown = "";
  private identity = "";
  private queue: string[] = [];

  update(text: string, identity: string): string {
    if (identity !== this.identity || !text.startsWith(this.target)) {
      this.shown = "";
      this.queue = [];
      this.target = "";
    }
    this.identity = identity;
    this.queue.push(...terminalChunks(text.slice(this.target.length)));
    this.target = text;
    return this.shown;
  }

  tick(): string {
    // Never flush the backlog in one frame, even when a response arrives whole.
    this.shown += this.queue.splice(0, 3).join("");
    return this.shown;
  }
}

/**
 * The contract between the harness and whatever is playing. The harness owns every
 * detail of talking to Jackbox; a Player only ever answers, gives three final
 * answers, and votes. Implementations must respect `deadlineMs` and return
 * *something* before it elapses; the harness will submit a blank if they do not.
 */

export interface PlayerContext {
  gameId: string;
  round: 1 | 2 | 3;
  /** Wall-clock deadline in ms since epoch. Return before this or the harness submits blank. */
  deadlineMs: number;
  /** Maximum answer length reported by the active controller state. */
  maxLength: number;
  /** Number of answer fields requested by the final-round controller state. */
  fieldCount?: number;
  /** Explanation supplied when the game rejected an earlier response. */
  feedback?: string;
  /** Revealed game history and this player's own prior answers. */
  gameHistory?: string;
  /** Optional hooks for live streaming of the model's process. */
  onThinking?: (delta: string) => void;
  onDraft?: (text: string) => void;
}

export interface Player {
  /** Display name to join the room with. Max 12 characters for Quiplash 3. */
  readonly name: string;
  /** Model slug or null for scripted/human players. */
  readonly modelId: string | null;
  /** Rounds 1-2. Return one answer within the context's game-provided limit. */
  answer(prompt: string, ctx: PlayerContext): Promise<string>;
  /** Round 3 (Thriplash). Three short lines. */
  answerFinal(prompt: string, ctx: PlayerContext): Promise<[string, string, string]>;
  /** Pick the funniest option by index. Options never include the player's own answer. */
  vote(prompt: string, options: string[], ctx: PlayerContext): Promise<number>;
}

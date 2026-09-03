import type { CSSProperties } from "react";

import type { AnswerTrace, LivePlayerState } from "../../../shared/types.js";
import { softColor } from "../color.js";

export const STATUS: Record<LivePlayerState["activity"], string> = {
  waiting: "waiting",
  thinking: "thinking",
  drafting: "drafting",
  submitted: "locked",
  voting: "voting",
  voted: "voted",
  done: "done",
  error: "error",
};

export function answerText(player: LivePlayerState): string | null {
  if (player.vote) {
    if (player.vote.choice === null) return null;
    return player.vote.options[player.vote.choice] ?? `option ${player.vote.choice + 1}`;
  }
  if (Array.isArray(player.answer)) return player.answer.join("  /  ");
  return player.answer ?? player.draft;
}

export function Pane({ player, index, trace }: { player: LivePlayerState; index: number; trace?: AnswerTrace }) {
  const answer = answerText(player);
  const streaming = player.activity === "thinking" || player.activity === "voting";
  const attempts = player.attempts.length > 0 ? player.attempts : trace?.attempts ?? [];
  const reasoningVisible = player.reasoningVisible ?? (trace
    ? trace.reasoningVisible ?? trace.reasoning.trim().length > 0
    : null);
  const fastRetry = attempts.some((attempt) => attempt.kind === "fast");
  const revisions = attempts.filter((attempt) => attempt.kind === "corrective").length;
  return (
    <article
      className="pane"
      data-activity={player.activity}
      style={{ "--player": softColor(player.avatarColor) } as CSSProperties}
    >
      <header className="pane__head">
        <span className="pane__index">{String(index + 1).padStart(2, "0")}</span>
        <span className="pane__name">{player.player.name}</span>
        <span className="pane__lab">{player.lab}</span>
        {player.activity !== "waiting" && <span className="pane__status">{STATUS[player.activity]}</span>}
      </header>
      <p className="pane__prompt">{player.prompt ?? (player.activity === "waiting" ? "" : "no prompt")}</p>
      <div className="pane__stream">
        {reasoningVisible === false
          ? <p className="pane__no-reasoning">no visible reasoning</p>
          : <pre className="pane__reasoning">{player.reasoning}{streaming && <span className="caret" aria-hidden="true" />}</pre>}
        {(fastRetry || revisions > 0) && (
          <div className="pane__trace-tags" aria-label="Trace attempts">
            {fastRetry && <span>retry</span>}
            {revisions > 0 && <span>revised {revisions}x</span>}
          </div>
        )}
      </div>
      <p className="pane__answer" data-kind={player.vote ? "vote" : "answer"}>
        {answer ?? <span className="pane__blank">{player.vote ? "voting" : player.activity === "waiting" ? "" : "none"}</span>}
      </p>
    </article>
  );
}

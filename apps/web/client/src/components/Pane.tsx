import type { CSSProperties } from "react";

import type { LivePlayerState } from "../../../shared/types.js";
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

export function Pane({ player, index }: { player: LivePlayerState; index: number }) {
  const answer = answerText(player);
  const streaming = player.activity === "thinking" || player.activity === "voting";
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
        <pre className="pane__reasoning">{player.reasoning}{streaming && <span className="caret" aria-hidden="true" />}</pre>
      </div>
      <p className="pane__answer" data-kind={player.vote ? "vote" : "answer"}>
        {answer ?? <span className="pane__blank">{player.vote ? "voting" : player.activity === "waiting" ? "" : "none"}</span>}
      </p>
    </article>
  );
}

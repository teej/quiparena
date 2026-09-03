import { useEffect, useRef } from "react";

import type { LivePlayerState } from "../../../shared/types.js";
import { ModelIdentity } from "./ModelIdentity.js";

const ACTIVITY_LABELS: Record<LivePlayerState["activity"], string> = {
  waiting: "Waiting",
  thinking: "Thinking",
  drafting: "Drafting",
  submitted: "Locked in",
  voting: "Choosing",
  voted: "Vote locked",
  done: "Finished",
  error: "Error",
};

export function PlayerCard({ player }: { player: LivePlayerState }) {
  const reasoningRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const element = reasoningRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [player.reasoning]);

  const answer = Array.isArray(player.answer) ? player.answer.join(" / ") : player.answer;
  return (
    <article className={`player-card player-card--${player.activity}`} style={{ "--player-color": player.avatarColor } as React.CSSProperties}>
      <header className="player-card__header">
        <ModelIdentity name={player.player.name} lab={player.lab} color={player.avatarColor} />
        <span className="activity"><i aria-hidden="true" />{ACTIVITY_LABELS[player.activity]}</span>
      </header>
      <div className="player-card__body">
        <section className="prompt-block">
          <span className="eyebrow">{player.vote ? "Voting on" : "Prompt"}</span>
          <p>{player.prompt ?? "Waiting for the next prompt…"}</p>
        </section>
        <details className="reasoning" open>
          <summary>
            <span>Reasoning trace</span>
            {player.reasoning && <span className="live-pulse">streaming</span>}
          </summary>
          <pre ref={reasoningRef}>{player.reasoning || "No reasoning yet."}</pre>
        </details>
        <div className="answer-block">
          <span className="eyebrow">{player.vote ? "Vote" : "Answer"}</span>
          {player.vote ? (
            <p>{player.vote.choice === null ? "Deciding…" : `Option ${player.vote.choice + 1} selected`}</p>
          ) : (
            <p>{answer ?? player.draft ?? "Not submitted"}</p>
          )}
        </div>
      </div>
    </article>
  );
}

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import type { LivePlayerState } from "../../../shared/types.js";
import { softColor } from "../color.js";
import { MatchupPanel } from "../components/MatchupPanel.js";
import { STATUS, answerText } from "../components/Pane.js";
import { useLiveEvents } from "../hooks/useLiveEvents.js";

const TV_WIDTH = 1920;
const TV_HEIGHT = 1080;

/** OBS renders the browser source at its configured size; the canvas is designed at 1920x1080 and
 *  scaled to fit whatever it is given. `?scale=0.5` pins the factor for sources that report odd sizes. */
function useScale(): number {
  const pinned = Number(new URLSearchParams(window.location.search).get("scale"));
  const fit = (): number => Math.min(window.innerWidth / TV_WIDTH, window.innerHeight / TV_HEIGHT);
  const [scale, setScale] = useState(() => (pinned > 0 ? pinned : fit()));
  useEffect(() => {
    if (pinned > 0) return;
    const onResize = (): void => setScale(fit());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pinned]);
  return scale;
}

function TvPlayer({ player }: { player: LivePlayerState }) {
  const viewport = useRef<HTMLParagraphElement>(null);
  const tooltipId = useId();
  const answer = answerText(player);
  const showAnswer = Boolean(answer && !player.vote);
  const reasoning = player.reasoning.trimEnd();
  const text = showAnswer ? answer! : reasoning || (player.vote && answer ? `Voted for: ${answer}` : player.prompt) || " ";
  const streaming = player.activity === "thinking" || player.activity === "voting";
  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = showAnswer ? 0 : viewport.current.scrollHeight;
  }, [text, showAnswer]);
  return <li className="tv__player" data-activity={player.activity}
    style={{ "--player": softColor(player.avatarColor) } as CSSProperties}
    tabIndex={reasoning ? 0 : undefined} aria-describedby={reasoning ? tooltipId : undefined}>
    <span className="tv__name">{player.player.name}</span>
    <span className="tv__status">{player.activity === "waiting" ? "" : STATUS[player.activity]}</span>
    <p className="tv__line" ref={viewport} data-kind={showAnswer ? "answer" : "reasoning"}>
      {text}{streaming && !showAnswer && <span className="caret" aria-hidden="true" />}
    </p>
    {reasoning && <div className="tv__thought" id={tooltipId} role="tooltip">
      <strong>{player.player.name} · {player.vote ? "voting thought" : "thinking"}</strong>
      <p>{reasoning}</p>
      {player.vote && answer && <p className="tv__thought-choice">Voted for: {answer}</p>}
    </div>}
  </li>;
}

export function TvPage() {
  const { state } = useLiveEvents();
  const scale = useScale();
  useEffect(() => {
    document.documentElement.classList.add("tv-html");
    document.body.classList.add("tv-body");
    return () => {
      document.documentElement.classList.remove("tv-html");
      document.body.classList.remove("tv-body");
    };
  }, []);
  const players = state.playerOrder.map((id) => state.players[id]).filter((player) => player !== undefined);
  return (
    <main className="tv" style={{ "--tv-scale": scale } as CSSProperties}>
      <aside className="tv__join" aria-label={`Room code ${state.roomCode ?? "unavailable"}`}>
        <span className="tv__join-label">room code</span>
        <strong className="tv__join-code">{state.roomCode ?? "----"}</strong>
        {state.audienceEnabled && <span className="tv__join-copy">join the audience at jackbox.tv</span>}
      </aside>
      <section className="tv__roster">
        <header className="tv__head">
          <span className="wordmark">quiparena</span>
          <span className="tv__room">
            round {state.round ?? "-"} of 3
          </span>
        </header>
        <ol className="tv__players">
          {players.map(player => <TvPlayer player={player} key={player.player.id} />)}
        </ol>
      </section>
      <MatchupPanel state={state} compact />
    </main>
  );
}

import { useEffect, useState, type CSSProperties } from "react";

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
      <section className="tv__roster">
        <header className="tv__head">
          <span className="wordmark">quiparena</span>
          <span className="tv__room">
            {state.roomCode ?? "----"}<span className="sep" aria-hidden="true">/</span>round {state.round ?? "-"} of 3
          </span>
        </header>
        <ol className="tv__players">
          {players.map((player) => {
            const answer = answerText(player);
            const tail = player.reasoning.trimEnd().slice(-140);
            return (
              <li className="tv__player" data-activity={player.activity} style={{ "--player": softColor(player.avatarColor) } as CSSProperties} key={player.player.id}>
                <span className="tv__name">{player.player.name}</span>
                <span className="tv__status">{player.activity === "waiting" ? "" : STATUS[player.activity]}</span>
                <p className="tv__line" data-kind={answer && !player.vote ? "answer" : "reasoning"}>
                  {answer && !player.vote ? answer : tail || player.prompt || " "}
                </p>
              </li>
            );
          })}
        </ol>
      </section>
      <MatchupPanel state={state} compact />
    </main>
  );
}

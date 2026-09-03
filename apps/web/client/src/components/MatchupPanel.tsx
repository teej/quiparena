import type { LiveState } from "../../../shared/types.js";

const LETTERS = ["A", "B"] as const;

export function MatchupPanel({ state, compact = false }: { state: LiveState; compact?: boolean }) {
  const current = state.currentVote;
  if (!current) return null;
  const answers = current.resolved?.answers ?? null;
  const texts = answers?.map((answer) => (answer.blank ? "no answer" : answer.text)) ?? current.options;
  const tallies = [0, 1].map((choice) => Object.values(current.votes).filter((vote) => vote === choice).length);
  const leader = tallies[0] === tallies[1] ? null : tallies[0]! > tallies[1]! ? 0 : 1;
  const nameOf = (id: string): string => state.players[id]?.player.name ?? id;

  return (
    <section className={`matchup${compact ? " matchup--compact" : ""}`} data-resolved={Boolean(current.resolved)}>
      <div className="matchup__kicker">
        <span>{current.resolved ? "resolved" : "voting"}</span>
        <span className="sep" aria-hidden="true">/</span>
        <span>round {current.round}</span>
      </div>
      <h2 className="matchup__prompt">{current.prompt}</h2>
      <div className="matchup__options">
        {texts.slice(0, 2).map((text, choice) => {
          const voters = Object.entries(current.votes).filter(([, vote]) => vote === choice).map(([id]) => nameOf(id));
          const author = answers?.[choice] ? nameOf(answers[choice]!.playerId) : null;
          return (
            <div className="option" data-leader={leader === choice} key={`${choice}-${text}`}>
              <span className="option__letter">{LETTERS[choice]}</span>
              <div className="option__body">
                <p className="option__text">{text}</p>
                <p className="option__meta">
                  {author && <span className="option__author">{author}</span>}
                  <span className="option__votes">{voters.length === 0 ? "—" : voters.join(", ")}</span>
                </p>
              </div>
              <span className="option__tally" aria-label={`${tallies[choice]} votes`}>{tallies[choice]}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

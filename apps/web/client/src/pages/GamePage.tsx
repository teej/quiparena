import type { Matchup } from "@quiparena/core";
import { Link, useParams } from "react-router";

import { replayEvents } from "../../../shared/reducer.js";
import type { AnswerTrace, ArchivedGame } from "../../../shared/types.js";
import { formatDate, formatScore } from "../api.js";
import { useApi } from "../hooks/useApi.js";

const LETTERS = ["A", "B"] as const;

function duration(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function traceAnnotation(trace: AnswerTrace | undefined): string | null {
  if (!trace) return null;
  const parts: string[] = [];
  if (trace.usage?.totalMs !== undefined) parts.push(duration(trace.usage.totalMs));
  if (trace.usage?.firstTokenMs != null) parts.push(`${duration(trace.usage.firstTokenMs)} first tok`);
  const reasoningTokens = trace.usage?.reasoningTokens
    ?? trace.attempts?.reduce((sum, attempt) => sum + attempt.reasoningTokens, 0);
  if (reasoningTokens !== undefined) parts.push(`${reasoningTokens} reasoning tok`);
  const revisions = Math.max(0, (trace.attempts?.length ?? 1) - 1);
  if (revisions > 0) parts.push(`revised ${revisions}x`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function Trace({ trace }: { trace: AnswerTrace | undefined }) {
  const annotation = traceAnnotation(trace);
  if (!trace?.reasoning) return (
    <div className="trace trace--none">
      {annotation && <p className="trace__timing">{annotation}</p>}
      <p>no reasoning kept</p>
    </div>
  );
  return (
    <details className="trace">
      <summary>reasoning{annotation && <span className="trace__timing">{annotation}</span>}</summary>
      <pre>{trace.reasoning}</pre>
    </details>
  );
}

/** An answer card whose whole face toggles the reasoning underneath it. */
function AnswerCard({ letter, text, author, voters, tally, leader, trace }: {
  letter: string; text: string; author: string; voters: string[]; tally: number; leader: boolean; trace: AnswerTrace | undefined;
}) {
  const hasTrace = Boolean(trace?.reasoning);
  const annotation = traceAnnotation(trace);
  const face = (
    <>
      <span className="option__letter">{letter}</span>
      <div className="option__body">
        <p className="option__text">{text}</p>
        <p className="option__meta">
          <span className="option__author">{author}</span>
          {annotation && <span className="option__timing">{annotation}</span>}
          <span className="option__votes">{voters.length ? voters.join(", ") : "—"}</span>
        </p>
      </div>
      <span className="option__tally" data-trace={hasTrace}>{tally}</span>
    </>
  );
  if (!hasTrace) return <section className="option option--replay" data-leader={leader}>{face}</section>;
  return (
    <details className="option option--replay" data-leader={leader}>
      <summary>{face}</summary>
      <pre className="option__trace">{trace?.reasoning}</pre>
    </details>
  );
}

function MatchupReplay({ matchup, data, number }: { matchup: Matchup; data: ArchivedGame; number: number }) {
  const nameOf = (id: string): string => data.game.players.find((player) => player.id === id)?.name ?? id;
  const playerVotes = matchup.votes.filter((vote) => vote.population === "player");
  const tallies = [0, 1].map((choice) => playerVotes.filter((vote) => vote.choice === choice).reduce((sum, vote) => sum + (vote.weight ?? 1), 0));
  const leader = tallies[0] === tallies[1] ? null : tallies[0]! > tallies[1]! ? 0 : 1;
  return (
    <article className="replay">
      <header className="replay__head">
        <span className="replay__number">{String(number).padStart(2, "0")}</span>
        <h3 className="replay__prompt">{matchup.prompt}</h3>
      </header>
      <div className="replay__answers">
        {matchup.answers.map((answer, choice) => (
          <AnswerCard
            key={answer.playerId}
            letter={LETTERS[choice] ?? "?"}
            text={answer.blank ? "no answer" : answer.text}
            author={nameOf(answer.playerId)}
            voters={playerVotes.filter((vote) => vote.choice === choice).map((vote) => nameOf(vote.voterId))}
            tally={tallies[choice] ?? 0}
            leader={leader === choice}
            trace={data.traces[answer.playerId]?.find((item) => item.prompt === matchup.prompt)}
          />
        ))}
      </div>
    </article>
  );
}

export function GamePage() {
  const { id = "" } = useParams();
  const { data, loading, error } = useApi<ArchivedGame>(`/api/games/${encodeURIComponent(id)}`);
  if (loading) return <div className="page"><p className="note">loading</p></div>;
  if (error || !data) return <div className="page"><p className="note note--error">{error ?? "No such game."}</p></div>;

  const replay = replayEvents(data.events);
  const game = data.game;
  const nameOf = (playerId: string): string => data.game.players.find((player) => player.id === playerId)?.name ?? playerId;
  const observed = game.observedScores !== undefined;
  const scores = Object.entries(game.observedScores ?? game.finalScores ?? {}).sort((left, right) => {
    const leftPlacement = game.observedPlacements?.[left[0]];
    const rightPlacement = game.observedPlacements?.[right[0]];
    if (leftPlacement !== undefined && rightPlacement !== undefined) return leftPlacement - rightPlacement;
    return right[1] - left[1];
  });
  let number = 0;

  return (
    <div className="page page--replay">
      <header className="page__head">
        <Link className="back" to="/games">← games</Link>
        <h1>Room {game.roomCode}</h1>
        <p>{formatDate(game.startedAt)}</p>
      </header>

      {([1, 2] as const).map((round) => (
        <section className="round" key={round}>
          <h2 className="rule-label"><span>round {round}{round === 2 ? "  /  double points" : ""}</span></h2>
          {replay.matchups.filter((matchup) => matchup.round === round).map((matchup) => {
            number += 1;
            return <MatchupReplay matchup={matchup} data={data} number={number} key={matchup.id} />;
          })}
        </section>
      ))}

      {replay.thriplash && (
        <section className="round">
          <h2 className="rule-label"><span>thriplash</span></h2>
          <article className="replay">
            <header className="replay__head">
              <span className="replay__number">{String(number + 1).padStart(2, "0")}</span>
              <h3 className="replay__prompt">{replay.thriplash.prompt}</h3>
            </header>
            <div className="thriplash">
              {replay.thriplash.entries.map((entry) => {
                const trace = data.traces[entry.playerId]?.find((item) => item.prompt === replay.thriplash?.prompt);
                const votes = replay.thriplash?.votes.filter((vote) => vote.population === "player" && replay.thriplash?.entries[vote.choice]?.playerId === entry.playerId).length ?? 0;
                return (
                  <section className="thriplash__entry" key={entry.playerId}>
                    <p className="option__meta"><span className="option__author">{nameOf(entry.playerId)}</span><span className="option__votes">{votes} {votes === 1 ? "vote" : "votes"}</span></p>
                    <ol>{entry.lines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ol>
                    <Trace trace={trace} />
                  </section>
                );
              })}
            </div>
          </article>
        </section>
      )}

      {scores.length > 0 && (
        <section className="standings">
          <h2 className="rule-label"><span>{observed ? "observed final" : "final"}</span></h2>
          <ol className="standings__list">
            {scores.map(([playerId, score], index) => (
              <li key={playerId} data-seat={index < 2 ? "kept" : "rotates"}>
                <span className="standings__rank">{game.observedPlacements?.[playerId] ?? index + 1}</span>
                <span className="standings__name">{nameOf(playerId)}</span>
                <span className="standings__note">{index < 2 ? "keeps the seat" : ""}</span>
                <span className="standings__score">{formatScore(score)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

import type { Matchup } from "@quiparena/core";
import { Link, useParams } from "react-router";

import { liveStateToGame, replayEvents } from "../../../shared/reducer.js";
import type { AnswerTrace, ArchivedGame } from "../../../shared/types.js";
import { formatDate, formatScore } from "../api.js";
import { useApi } from "../hooks/useApi.js";

function Trace({ trace }: { trace: AnswerTrace | undefined }) {
  return (
    <details className="archive-trace">
      <summary>Reasoning trace</summary>
      <pre>{trace?.reasoning || "This trace was not retained."}</pre>
    </details>
  );
}

function MatchupReplay({ matchup, data }: { matchup: Matchup; data: ArchivedGame }) {
  return (
    <article className="replay-matchup">
      <header><span className="matchup-number">{String(matchup.index + 1).padStart(2, "0")}</span><h3>{matchup.prompt}</h3></header>
      <div className="replay-answers">
        {matchup.answers.map((answer, choice) => {
          const author = data.game.players.find((player) => player.id === answer.playerId);
          const trace = data.traces[answer.playerId]?.find((item) => item.prompt === matchup.prompt);
          const votes = matchup.votes.filter((vote) => vote.choice === choice && vote.population === "player")
            .reduce((sum, vote) => sum + (vote.weight ?? 1), 0);
          return (
            <section key={answer.playerId}>
              <div className="answer-meta"><span>{String.fromCharCode(65 + choice)}</span><strong>{author?.name ?? answer.playerId}</strong><small>{votes} votes</small></div>
              <blockquote>{answer.blank ? "No answer" : answer.text}</blockquote>
              <Trace trace={trace} />
            </section>
          );
        })}
      </div>
      <footer>
        {matchup.votes.filter((vote) => vote.population === "player").map((vote) => {
          const voter = data.game.players.find((player) => player.id === vote.voterId);
          return <span key={`${vote.voterId}-${vote.choice}`}>{voter?.name ?? vote.voterId} → {String.fromCharCode(65 + vote.choice)}</span>;
        })}
      </footer>
    </article>
  );
}

export function GamePage() {
  const { id = "" } = useParams();
  const { data, loading, error } = useApi<ArchivedGame>(`/api/games/${encodeURIComponent(id)}`);
  if (loading) return <div className="loading-panel">Rebuilding game tape…</div>;
  if (error || !data) return <div className="error-banner">{error ?? "Game not found"}</div>;

  const replay = replayEvents(data.events);
  const replayedGame = liveStateToGame(replay) ?? data.game;
  const rounds = [1, 2] as const;
  const scores = Object.entries(replayedGame.finalScores ?? {}).sort((left, right) => right[1] - left[1]);
  return (
    <div className="page-stack replay-page">
      <Link className="back-link" to="/games">← All games</Link>
      <header className="replay-hero">
        <div><span className="eyebrow">Room {replayedGame.roomCode}</span><h1>Game replay</h1><p>{formatDate(replayedGame.startedAt)}</p></div>
        <div className="winner-card">
          <span className="eyebrow">Final leader</span>
          <strong>{data.game.players.find((player) => player.id === scores[0]?.[0])?.name ?? "In progress"}</strong>
          <span>{scores[0] ? formatScore(scores[0][1]) : "—"} pts</span>
        </div>
      </header>

      {rounds.map((round) => (
        <section className="round-section" key={round}>
          <div className="round-heading"><span>Round {round}</span><small>{round === 2 ? "Double points" : "Head to head"}</small></div>
          {replay.matchups.filter((matchup) => matchup.round === round).map((matchup) => (
            <MatchupReplay matchup={matchup} data={data} key={matchup.id} />
          ))}
        </section>
      ))}

      {replay.thriplash && (
        <section className="round-section">
          <div className="round-heading"><span>Thriplash</span><small>Three answers each</small></div>
          <article className="thriplash-replay">
            <h2>{replay.thriplash.prompt}</h2>
            <div>
              {replay.thriplash.entries.map((entry) => {
                const player = data.game.players.find((item) => item.id === entry.playerId);
                const trace = data.traces[entry.playerId]?.find((item) => item.prompt === replay.thriplash?.prompt);
                return (
                  <section key={entry.playerId}>
                    <strong>{player?.name ?? entry.playerId}</strong>
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
        <section className="final-table">
          <div className="round-heading"><span>Final scores</span><small>Room {replayedGame.roomCode}</small></div>
          <ol>{scores.map(([playerId, score], index) => <li key={playerId}><span>{index + 1}</span><strong>{data.game.players.find((player) => player.id === playerId)?.name ?? playerId}</strong><em>{formatScore(score)}</em></li>)}</ol>
        </section>
      )}
    </div>
  );
}

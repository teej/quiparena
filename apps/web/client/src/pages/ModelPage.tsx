import { Link, useParams, useSearchParams } from "react-router";
import type { ModelHistory } from "../../../shared/types.js";
import { useApi } from "../hooks/useApi.js";
import { formatDate } from "../api.js";
import "./model.css";

export function ModelPage() {
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const { data, loading, error } = useApi<ModelHistory>(`/api/models/${encodeURIComponent(slug)}?offset=${offset}`);
  const groups: Array<{ gameId: string; startedAt: string; answers: ModelHistory["answers"] }> = [];
  for (const answer of data?.answers ?? []) {
    let group = groups.at(-1);
    if (group?.gameId !== answer.gameId) {
      group = { gameId: answer.gameId, startedAt: answer.startedAt, answers: [] };
      groups.push(group);
    }
    group.answers.push(answer);
  }
  return <div className="page model-page">
    <header className="model-page__head">
      <Link className="model-page__back" to="/leaderboard">← Leaderboard</Link>
      <div>
        <h1>{data?.model.name ?? "Model history"}</h1>
        <p className="model-page__id">{data?.model.slug ?? slug}</p>
      </div>
    </header>
    <div className="model-page__section-title">Answer history</div>
    {loading && <p className="note">Loading answers…</p>}
    {error && <p className="note note--error">{error}</p>}
    {data && !data.answers.length && <p className="note">No saved answers yet.</p>}
    <div className="model-history">
      {groups.map(group => <section className="model-game" key={group.gameId} aria-label={`Game ${formatDate(group.startedAt)}`}>
        <header className="model-game__head">
          <time dateTime={group.startedAt}>{formatDate(group.startedAt)}</time>
          <Link to={`/games/${encodeURIComponent(group.gameId)}`}>View game <span aria-hidden="true">↗</span></Link>
        </header>
        {group.answers.map(answer => {
          const hasAnswer = Boolean(answer.text && answer.text !== "⁇");
          return <article className="model-answer" key={answer.id}>
            <span className="model-answer__round">{answer.round === 3 ? "Final" : `R${answer.round}`}</span>
            <div className="model-answer__body">
              <h2 className="model-answer__prompt">{answer.prompt}</h2>
              <p className="model-answer__text" data-empty={!hasAnswer}>{hasAnswer ? answer.text : "—"}</p>
              {answer.blank && hasAnswer && <span className="model-answer__fallback">Game-provided fallback</span>}
            </div>
          </article>;
        })}
      </section>)}
    </div>
    <nav className="model-page__pagination" aria-label="Answer history pages">
      <button disabled={offset === 0 || loading} onClick={() => setParams({ offset: String(Math.max(0, offset - 50)) })}>← Newer answers</button>
      <button disabled={!data?.hasMore || loading} onClick={() => setParams({ offset: String(offset + 50) })}>Older answers →</button>
    </nav>
  </div>;
}

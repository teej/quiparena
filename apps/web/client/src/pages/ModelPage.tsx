import { Link, useParams, useSearchParams } from "react-router";
import type { ModelHistory } from "../../../shared/types.js";
import { useApi } from "../hooks/useApi.js";
import { formatDate } from "../api.js";

export function ModelPage() {
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const { data, loading, error } = useApi<ModelHistory>(`/api/models/${encodeURIComponent(slug)}?offset=${offset}`);
  return <div className="page">
    <header className="page__head">
      <Link to="/leaderboard">← Leaderboard</Link>
      <h1>{data?.model.name ?? "Model history"}</h1>
      <p>{data?.model.slug ?? slug}</p>
      <p>Saved answers from every scoring season, newest games first.</p>
    </header>
    {loading && <p className="note">Loading answers…</p>}
    {error && <p className="note note--error">{error}</p>}
    {data && !data.answers.length && <p className="note">No saved answers yet.</p>}
    {data?.answers.map(answer => <article className="replay" key={answer.id}>
      <header className="replay__head"><h2 className="replay__prompt">{answer.prompt}</h2></header>
      <div className="option option--replay"><div className="option__body">
        <p className="option__text" style={{ whiteSpace: "pre-line" }}>{answer.blank ? "No answer submitted" : answer.text}</p>
        <p className="option__meta"><Link to={`/games/${encodeURIComponent(answer.gameId)}`}>{formatDate(answer.startedAt)} · Round {answer.round} · View game ↗</Link></p>
      </div></div>
    </article>)}
    <div className="segmented" role="group" aria-label="Answer history pages">
      <button disabled={offset === 0 || loading} onClick={() => setParams({ offset: String(Math.max(0, offset - 50)) })}>Newer answers</button>
      <button disabled={!data?.hasMore || loading} onClick={() => setParams({ offset: String(offset + 50) })}>Older answers</button>
    </div>
  </div>;
}

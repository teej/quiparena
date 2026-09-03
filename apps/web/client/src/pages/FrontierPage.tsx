import { useEffect, useMemo, useRef, useState } from "react";

import type { FrontierEntry, FrontierResponse } from "../../../shared/frontier.js";
import { useApi } from "../hooks/useApi.js";
import { POPULATIONS, usePopulation } from "../hooks/usePopulation.js";
import "./frontier.css";

/* ------------------------------------------------------------------ format */

export function formatUsd(value: number | null): string {
  if (value === null) return "–";
  if (value >= 1) return `$${value.toFixed(2)}`;
  const decimals = Math.min(7, Math.max(2, -Math.floor(Math.log10(value)) + 1));
  const text = value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, ".0");
  return `$${text.endsWith(".0") ? `${text}0` : text}`;
}

function formatMs(value: number | null): string {
  if (value === null) return "–";
  return `${(value / 1000).toFixed(1)}s`;
}

function formatInt(value: number | null): string {
  if (value === null) return "–";
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

/* ---------------------------------------------------------------- frontier */

/** Cheaper-and-better: nobody else has cost <= and rating >= with one strict. */
export function paretoFrontier(points: readonly FrontierEntry[]): Set<string> {
  const priced = points.filter((point) => point.costPerWinUsd !== null);
  const frontier = new Set<string>();
  for (const point of priced) {
    const cost = point.costPerWinUsd ?? 0;
    const dominated = priced.some((other) => other !== point
      && (other.costPerWinUsd ?? 0) <= cost
      && other.rating >= point.rating
      && ((other.costPerWinUsd ?? 0) < cost || other.rating > point.rating));
    if (!dominated) frontier.add(point.slug);
  }
  return frontier;
}

/* ------------------------------------------------------------------ scales */

interface Scale {
  (value: number): number;
  ticks: number[];
}

function logScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = [Math.log10(domain[0]), Math.log10(domain[1])];
  const scale = ((value: number) => range[0] + ((Math.log10(value) - d0) / (d1 - d0)) * (range[1] - range[0])) as Scale;
  const ticks: number[] = [];
  for (let exponent = Math.floor(d0); exponent <= Math.ceil(d1); exponent += 1) {
    for (const mantissa of [1, 2, 5]) {
      const value = mantissa * 10 ** exponent;
      if (value >= domain[0] && value <= domain[1]) ticks.push(value);
    }
  }
  scale.ticks = ticks;
  return scale;
}

function linearScale(domain: [number, number], range: [number, number], step: number): Scale {
  const scale = ((value: number) => range[0] + ((value - domain[0]) / (domain[1] - domain[0])) * (range[1] - range[0])) as Scale;
  const ticks: number[] = [];
  for (let value = Math.ceil(domain[0] / step) * step; value <= domain[1]; value += step) ticks.push(value);
  scale.ticks = ticks;
  return scale;
}

function isDecade(value: number): boolean {
  const exponent = Math.log10(value);
  return Math.abs(exponent - Math.round(exponent)) < 1e-9;
}

/* ------------------------------------------------------------------- chart */

const HEIGHT = 440;
const MARGIN = { top: 20, right: 28, bottom: 44, left: 56 };
const LABEL_CHAR = 6.7; // px per mono char at 11px, for collision boxes

interface Placed {
  entry: FrontierEntry;
  x: number;
  y: number;
  r: number;
  labelX: number;
  labelY: number;
  anchor: "start" | "end";
}

function useWidth<T extends HTMLElement>(fallback: number): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next) setWidth(next);
    });
    observer.observe(node);
    setWidth(node.clientWidth || fallback);
    return () => observer.disconnect();
  }, [fallback]);
  return [ref, width];
}

function layout(points: readonly FrontierEntry[], width: number, x: Scale, y: Scale): Placed[] {
  const right = width - MARGIN.right;
  const placed: Placed[] = points.map((entry) => {
    const px = x(entry.costPerWinUsd ?? 1);
    const py = y(entry.rating);
    const r = Math.min(12, 4 + Math.sqrt(entry.games) * 1.8);
    const labelWidth = entry.displayName.length * LABEL_CHAR;
    const anchor: "start" | "end" = px + r + 6 + labelWidth > right ? "end" : "start";
    return {
      entry,
      x: px,
      y: py,
      r,
      labelX: anchor === "start" ? px + r + 6 : px - r - 6,
      labelY: py + 4,
      anchor,
    };
  });
  // Greedy nudge: scan top to bottom, push a label down while it sits on a placed one.
  const boxes: Array<{ x0: number; x1: number; y: number }> = [];
  for (const item of [...placed].sort((left, right) => left.labelY - right.labelY)) {
    const width = item.entry.displayName.length * LABEL_CHAR;
    const x0 = item.anchor === "start" ? item.labelX : item.labelX - width;
    const x1 = x0 + width;
    let guard = 0;
    while (guard < 12 && boxes.some((box) => box.x0 < x1 + 4 && box.x1 > x0 - 4 && Math.abs(box.y - item.labelY) < 13)) {
      item.labelY += 13;
      guard += 1;
    }
    boxes.push({ x0, x1, y: item.labelY });
  }
  return placed;
}

function stepPath(frontier: readonly Placed[], right: number, bottom: number): string {
  if (frontier.length === 0) return "";
  const sorted = [...frontier].sort((left, right) => left.x - right.x);
  const first = sorted[0]!;
  let path = `M${first.x.toFixed(1)},${bottom} V${first.y.toFixed(1)}`;
  for (let index = 1; index < sorted.length; index += 1) {
    const point = sorted[index]!;
    path += ` H${point.x.toFixed(1)} V${point.y.toFixed(1)}`;
  }
  return `${path} H${right}`;
}

function Tooltip({ point, width }: { point: Placed; width: number }) {
  const { entry } = point;
  const flip = point.x > width * 0.62;
  const style: React.CSSProperties = flip
    ? { right: width - point.x + point.r + 10, top: point.y - 12 }
    : { left: point.x + point.r + 10, top: point.y - 12 };
  const rows: Array<[string, string]> = [
    ["rating", `${entry.rating} ±${entry.plusMinus}`],
    ["$ / win", formatUsd(entry.costPerWinUsd)],
    ["$ / answer", formatUsd(entry.costPerAnswerUsd)],
    ["spend", formatUsd(entry.totalCostUsd || null)],
    ["matchups", `${entry.matchupWins}–${entry.matchupsPlayed - entry.matchupWins}`],
    ["answers", String(entry.answers)],
    ["games", String(entry.games)],
    ["time / answer", formatMs(entry.avgAnswerMs)],
    ["reasoning tok", formatInt(entry.reasoningTokensPerAnswer)],
  ];
  return (
    <div className="frontier__tip" style={style} role="status">
      <div className="frontier__tip-head"><strong>{entry.displayName}</strong><span>{entry.slug}</span></div>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
    </div>
  );
}

function FrontierChart({ entries, frontier }: { entries: readonly FrontierEntry[]; frontier: Set<string> }) {
  const [ref, width] = useWidth<HTMLDivElement>(920);
  const [active, setActive] = useState<string | null>(null);
  const points = useMemo(() => entries.filter((entry) => entry.costPerWinUsd !== null && entry.costPerWinUsd > 0), [entries]);

  const plot = useMemo(() => {
    const costs = points.map((point) => point.costPerWinUsd ?? 1);
    const ratings = points.map((point) => point.rating);
    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    const xDomain: [number, number] = [10 ** (Math.log10(minCost) - 0.3), 10 ** (Math.log10(maxCost) + 0.3)];
    const spread = Math.max(...ratings) - Math.min(...ratings);
    const step = spread > 250 ? 100 : 50;
    const pad = Math.max(step, spread * 0.12);
    const yDomain: [number, number] = [
      Math.floor((Math.min(...ratings) - pad) / step) * step,
      Math.ceil((Math.max(...ratings) + pad) / step) * step,
    ];
    const x = logScale(xDomain, [MARGIN.left, width - MARGIN.right]);
    const y = linearScale(yDomain, [HEIGHT - MARGIN.bottom, MARGIN.top], step);
    const placed = layout(points, width, x, y);
    return { x, y, placed };
  }, [points, width]);

  const right = width - MARGIN.right;
  const bottom = HEIGHT - MARGIN.bottom;
  const frontierPoints = plot.placed.filter((item) => frontier.has(item.entry.slug));
  const activePoint = plot.placed.find((item) => item.entry.slug === active) ?? null;

  return (
    <div className="frontier__chart" ref={ref} onPointerLeave={() => setActive(null)}>
      <svg className="frontier__svg" width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label="Rating against cost per winning joke">
        <g className="frontier__grid">
          {plot.y.ticks.map((tick) => (
            <line key={`y${tick}`} x1={MARGIN.left} x2={right} y1={plot.y(tick)} y2={plot.y(tick)} />
          ))}
          {plot.x.ticks.filter(isDecade).map((tick) => (
            <line key={`x${tick}`} x1={plot.x(tick)} x2={plot.x(tick)} y1={MARGIN.top} y2={bottom} />
          ))}
        </g>
        <g className="frontier__axis">
          <line x1={MARGIN.left} x2={right} y1={bottom} y2={bottom} />
          <line x1={MARGIN.left} x2={MARGIN.left} y1={MARGIN.top} y2={bottom} />
        </g>
        <g className="frontier__ticks">
          {plot.y.ticks.map((tick) => (
            <text key={`y${tick}`} x={MARGIN.left - 8} y={plot.y(tick) + 4} textAnchor="end">{tick}</text>
          ))}
          {plot.x.ticks.map((tick) => (
            <text key={`x${tick}`} x={plot.x(tick)} y={bottom + 16} textAnchor="middle" className={isDecade(tick) ? "" : "frontier__tick--minor"}>
              {formatUsd(tick)}
            </text>
          ))}
        </g>
        <text className="frontier__axis-label" x={right} y={bottom + 34} textAnchor="end">$ per winning joke / log</text>
        <text className="frontier__axis-label" x={MARGIN.left} y={MARGIN.top - 8} textAnchor="start">rating</text>

        <path className="frontier__path" d={stepPath(frontierPoints, right, bottom)} />

        <g className="frontier__labels">
          {plot.placed.filter((item) => item.labelY !== item.y + 4).map((item) => (
            <line
              key={`lead-${item.entry.slug}`}
              className="frontier__leader"
              x1={item.x}
              y1={item.y}
              x2={item.anchor === "start" ? item.labelX - 3 : item.labelX + 3}
              y2={item.labelY - 4}
            />
          ))}
          {plot.placed.map((item) => (
            <text
              key={item.entry.slug}
              x={item.labelX}
              y={item.labelY}
              textAnchor={item.anchor}
              className={frontier.has(item.entry.slug) ? "frontier__label frontier__label--frontier" : "frontier__label"}
            >
              {item.entry.displayName}
            </text>
          ))}
        </g>

        <g className="frontier__marks">
          {plot.placed.map((item) => {
            const onFrontier = frontier.has(item.entry.slug);
            const isActive = active === item.entry.slug;
            return (
              <g
                key={item.entry.slug}
                className={`frontier__mark${onFrontier ? " frontier__mark--frontier" : ""}${isActive ? " frontier__mark--active" : ""}`}
                tabIndex={0}
                role="button"
                aria-label={`${item.entry.displayName}: rating ${item.entry.rating}, ${formatUsd(item.entry.costPerWinUsd)} per win`}
                onPointerEnter={() => setActive(item.entry.slug)}
                onPointerDown={() => setActive(isActive ? null : item.entry.slug)}
                onFocus={() => setActive(item.entry.slug)}
                onBlur={() => setActive(null)}
              >
                <circle className="frontier__hit" cx={item.x} cy={item.y} r={Math.max(14, item.r + 6)} />
                <circle className="frontier__dot" cx={item.x} cy={item.y} r={item.r} />
              </g>
            );
          })}
        </g>
      </svg>
      {activePoint && <Tooltip point={activePoint} width={width} />}
    </div>
  );
}

/* ------------------------------------------------------------------- table */

type SortKey = keyof Pick<FrontierEntry,
  "displayName" | "rating" | "costPerWinUsd" | "costPerAnswerUsd" | "totalCostUsd" | "matchupWins" | "answers" | "avgAnswerMs" | "reasoningTokensPerAnswer" | "games">;

const COLUMNS: ReadonlyArray<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: "displayName", label: "model", numeric: false },
  { key: "rating", label: "rating", numeric: true },
  { key: "costPerWinUsd", label: "$ / win", numeric: true },
  { key: "costPerAnswerUsd", label: "$ / answer", numeric: true },
  { key: "totalCostUsd", label: "spend", numeric: true },
  { key: "matchupWins", label: "matchups", numeric: true },
  { key: "answers", label: "answers", numeric: true },
  { key: "avgAnswerMs", label: "time", numeric: true },
  { key: "reasoningTokensPerAnswer", label: "reasoning", numeric: true },
  { key: "games", label: "games", numeric: true },
];

function compare(left: FrontierEntry, right: FrontierEntry, key: SortKey, direction: 1 | -1): number {
  const a = left[key];
  const b = right[key];
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b) * direction;
  return ((a as number) - (b as number)) * direction;
}

function FrontierTable({ entries, frontier }: { entries: readonly FrontierEntry[]; frontier: Set<string> }) {
  const [sort, setSort] = useState<{ key: SortKey; direction: 1 | -1 }>({ key: "rating", direction: -1 });
  // Columns nobody has reported yet stay out of the way.
  const columns = COLUMNS.filter((column) => (
    (column.key !== "avgAnswerMs" && column.key !== "reasoningTokensPerAnswer") || entries.some((entry) => entry[column.key] !== null)
  ));
  const visible = new Set(columns.map((column) => column.key));
  const sorted = useMemo(
    () => [...entries].sort((left, right) => compare(left, right, sort.key, sort.direction) || right.rating - left.rating),
    [entries, sort],
  );
  const toggle = (key: SortKey): void => {
    setSort((current) => (current.key === key
      ? { key, direction: current.direction === 1 ? -1 : 1 }
      : { key, direction: key === "displayName" || key === "costPerWinUsd" || key === "costPerAnswerUsd" || key === "avgAnswerMs" ? 1 : -1 }));
  };

  return (
    <table className="board frontier-table">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} className={column.numeric ? "num" : ""} aria-sort={sort.key === column.key ? (sort.direction === 1 ? "ascending" : "descending") : "none"}>
              <button type="button" onClick={() => toggle(column.key)} data-active={sort.key === column.key}>
                {column.label}{sort.key === column.key ? (sort.direction === 1 ? " ▴" : " ▾") : ""}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((entry) => (
          <tr key={entry.slug} data-frontier={frontier.has(entry.slug)}>
            <td>
              <strong>{frontier.has(entry.slug) && <i className="frontier__flag" aria-label="on the frontier" />}{entry.displayName}</strong>
              <span className="board__id">{entry.slug}</span>
            </td>
            <td className="num board__rating">{entry.rating} <span className="board__plus-minus">±{entry.plusMinus}</span></td>
            <td className="num">{formatUsd(entry.costPerWinUsd)}</td>
            <td className="num">{formatUsd(entry.costPerAnswerUsd)}</td>
            <td className="num">{formatUsd(entry.totalCostUsd || null)}</td>
            <td className="num">{entry.matchupWins}–{entry.matchupsPlayed - entry.matchupWins}</td>
            <td className="num">{entry.answers}</td>
            {visible.has("avgAnswerMs") && <td className="num">{formatMs(entry.avgAnswerMs)}</td>}
            {visible.has("reasoningTokensPerAnswer") && <td className="num">{formatInt(entry.reasoningTokensPerAnswer)}</td>}
            <td className="num">{entry.games}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* -------------------------------------------------------------------- page */

export function FrontierPage() {
  const [population, setPopulation] = usePopulation();
  const { data, loading, error } = useApi<FrontierResponse>(`/api/frontier?population=${population}`);
  const entries = data?.entries ?? [];
  const frontier = useMemo(() => paretoFrontier(entries), [entries]);
  const plotted = entries.filter((entry) => entry.costPerWinUsd !== null && entry.costPerWinUsd > 0).length;
  const unpriced = entries.filter((entry) => entry.costPerWinUsd === null && entry.matchupWins > 0).length;
  const maxGames = entries.reduce((most, entry) => Math.max(most, entry.games), 0);

  return (
    <div className="page frontier">
      <header className="page__head">
        <h1>Frontier</h1>
        <p>
          Everything a model spent, divided by the matchups it won on a majority vote, against its leaderboard rating: up and left is the good corner.
        </p>
      </header>
      <div className="segmented" role="group" aria-label="Whose votes">
        <span className="segmented__label">voters</span>
        {POPULATIONS.map(([value, label]) => (
          <button type="button" aria-pressed={population === value} onClick={() => setPopulation(value)} key={value}>{label}</button>
        ))}
      </div>
      {loading && <p className="note">loading</p>}
      {error && <p className="note note--error">{error}</p>}
      {data && entries.length === 0 && (
        <p className="note">
          {population === "player" ? "No rated matchups yet." : "Chat voting is not wired up yet, so there is nothing to rate here."}
        </p>
      )}
      {entries.length > 0 && plotted < 2 && (
        <p className="note">Not enough priced wins to draw a frontier yet. Table only.</p>
      )}
      {plotted >= 2 && <FrontierChart entries={entries} frontier={frontier} />}
      {entries.length > 0 && (plotted >= 2 && (unpriced > 0 || maxGames < 5)) && (
        <p className="note frontier__note">
          {maxGames < 5 ? `Early: no model has more than ${maxGames} game${maxGames === 1 ? "" : "s"} yet.` : ""}
          {maxGames < 5 && unpriced > 0 ? " / " : ""}
          {unpriced > 0 ? `${unpriced} model${unpriced === 1 ? "" : "s"} report no price and sit in the table only.` : ""}
        </p>
      )}
      {entries.length > 0 && <FrontierTable entries={entries} frontier={frontier} />}
    </div>
  );
}

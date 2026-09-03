import type { AnyEvent } from "@quiparena/core";

export interface CompactLogLine {
  level: "log" | "error";
  text: string;
}

function normalized(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || "(blank entry)";
}

/** Stateful, pure formatter for the human-facing worker log. */
export class CompactGameLogFormatter {
  readonly costs = new Map<string, number>();
  readonly #names = new Map<string, string>();
  readonly #models = new Map<string, string>();
  readonly #voteOptions = new Map<string, string[]>();
  readonly #shownPrompts = new Set<string>();
  readonly #shownR3Answers = new Set<string>();
  readonly #thriplashOwners = new Map<string, Map<string, string>>();

  format(event: AnyEvent): CompactLogLine[] {
    const line = (text: string, level: CompactLogLine["level"] = "log"): CompactLogLine[] => [{ level, text }];
    switch (event.type) {
      case "player.joined":
        this.#names.set(event.player.id, event.player.name);
        if (event.player.modelId) this.#models.set(event.player.id, event.player.modelId);
        return line(`join  ${event.player.name}${event.player.modelId ? ` (${event.player.modelId})` : ""}`);
      case "prompt.dealt": {
        const key = `${event.gameId}\0${event.round}\0${event.prompt}`;
        if (this.#shownPrompts.has(key)) return [];
        this.#shownPrompts.add(key);
        return line(`R${event.round} prompt  ${event.prompt}`);
      }
      case "answer.submitted": {
        if (!Array.isArray(event.answer)) {
          return line(`  ${this.#label(event.playerId)}: ${event.answer}${event.blank ? " [fallback]" : ""}`);
        }
        const owners = this.#thriplashOwners.get(event.gameId) ?? new Map<string, string>();
        owners.set(normalized(event.answer.join("\n")), this.#label(event.playerId));
        this.#thriplashOwners.set(event.gameId, owners);
        const header = this.#shownR3Answers.has(event.gameId)
          ? []
          : [{ level: "log" as const, text: "R3 answers" }];
        this.#shownR3Answers.add(event.gameId);
        return [
          ...header,
          {
            level: "log",
            text: `  ${this.#label(event.playerId)} → ${event.answer.join(" / ")}${event.blank ? " [fallback]" : ""}`,
          },
        ];
      }
      case "vote.requested": {
        const owners = this.#thriplashOwners.get(event.gameId);
        const options = event.options.map((option) => event.round === 3
          ? owners?.get(normalized(option)) ?? firstLine(option)
          : option.replace(/\s+/g, " ").trim());
        this.#voteOptions.set(this.#voteKey(event.gameId, event.playerId, event.prompt), options);
        return [];
      }
      case "vote.cast": {
        const options = this.#voteOptions.get(this.#voteKey(event.gameId, event.playerId, event.prompt));
        const selected = options?.[event.choice]
          ?? (event.answer ? firstLine(event.answer) : `#${event.choice + 1}`);
        return line(`  vote ${this.#label(event.playerId)} → ${selected}`);
      }
      case "matchup.resolved": {
        const [left, right] = event.matchup.answers;
        const leftVotes = event.matchup.votes.filter((vote) => vote.choice === 0)
          .reduce((sum, vote) => sum + (vote.weight ?? 1), 0);
        const rightVotes = event.matchup.votes.filter((vote) => vote.choice === 1)
          .reduce((sum, vote) => sum + (vote.weight ?? 1), 0);
        return line(`  result ${this.#label(left.playerId)} ${leftVotes}–${rightVotes} ${this.#label(right.playerId)}`);
      }
      case "thriplash.resolved":
        return line(`  thriplash resolved (${event.thriplash.votes.length} votes)`);
      case "game.ended":
        return line(event.finalScores
          ? `final ${Object.entries(event.finalScores).sort((a, b) => b[1] - a[1]).map(([id, score]) => `${this.#label(id)}=${score}`).join("  ")}`
          : "final scores unavailable");
      case "trace.completed": {
        const model = this.#models.get(event.playerId) ?? event.playerId;
        this.costs.set(model, (this.costs.get(model) ?? 0) + (event.usage?.costUsd ?? 0));
        return [];
      }
      case "harness.error": {
        const details = [
          event.reason ? `reason=${event.reason}` : "",
          event.stateKey ? `state=${event.stateKey}` : "",
          event.missedOccurrences === undefined ? "" : `missed=${event.missedOccurrences}`,
        ].filter(Boolean).join(" ");
        return line(
          `!!! HARNESS ERROR${event.playerId ? ` ${this.#label(event.playerId)}` : ""}: ${event.message}`
          + `${details ? ` [${details}]` : ""} !!!`,
          "error",
        );
      }
      default:
        return [];
    }
  }

  #label(playerId: string): string {
    return this.#names.get(playerId) ?? playerId;
  }

  #voteKey(gameId: string, playerId: string, prompt: string): string {
    return `${gameId}\0${playerId}\0${prompt}`;
  }
}

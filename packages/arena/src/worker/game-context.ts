import type { AnyEvent, PlayerRef } from "@quiparena/core";
import type { Player, PlayerContext } from "@quiparena/jackbox";

/** Only revealed game events and the requesting player's own submissions enter a request. */
export class GameContext {
  private readonly players = new Map<string, PlayerRef>();
  private readonly publicEvents = new Map<string, unknown>();
  private readonly ownAnswers = new Map<string, Array<unknown>>();

  constructor(readonly gameId: string) {}

  consume(event: AnyEvent): void {
    if (event.gameId !== this.gameId) return;
    switch (event.type) {
      case "player.joined": this.players.set(event.player.id, event.player); break;
      case "answer.submitted": {
        const previous = this.ownAnswers.get(event.playerId) ?? [];
        previous.push({ round: event.round, prompt: event.prompt, answer: event.answer });
        this.ownAnswers.set(event.playerId, previous);
        break;
      }
      case "matchup.resolved":
        this.publicEvents.set(event.matchup.id, {
          round: event.matchup.round, prompt: event.matchup.prompt,
          answers: event.matchup.answers.map((a, index) => ({
            player: this.players.get(a.playerId)?.name ?? "Unknown player", answer: a.text,
            votes: event.matchup.votes.filter(v => v.choice === index).reduce((sum, v) => sum + (v.weight ?? 1), 0),
          })),
        });
        break;
      case "matchup.observed":
        this.publicEvents.set(`observed:${event.prompt}`, { prompt: event.prompt, answers: event.answers, winner: event.winner, percentages: event.percentages });
        break;
      case "scoreboard.observed":
        this.publicEvents.set(`scores:${event.round}`, { round: event.round, scores: event.standings });
        break;
    }
  }

  mask(text: string): string {
    const replacements = [...this.players.values()].flatMap((p, i) =>
      [p.name, p.modelId].filter((s): s is string => Boolean(s)).map(name => ({ name, alias: `Player ${i + 1}` })));
    replacements.sort((a, b) => b.name.length - a.name.length);
    if (!replacements.length) return text;
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(replacements.map(r => escape(r.name)).join("|"), "gi");
    return text.replace(pattern, match => replacements.find(r => r.name.toLowerCase() === match.toLowerCase())!.alias);
  }

  snapshot(name: string, anonymous: boolean): string {
    const self = [...this.players.values()].find(p => p.name === name);
    const text = JSON.stringify({
      players: [...this.players.values()].map(p => p.name),
      you: name,
      revealed: [...this.publicEvents.values()],
      yourPreviousAnswers: self ? this.ownAnswers.get(self.id) ?? [] : [],
    });
    return anonymous ? this.mask(text) : text;
  }

  wrap(player: Player): Player {
    const context = (ctx: PlayerContext, voting = false): PlayerContext => ({
      ...ctx,
      gameHistory: this.snapshot(player.name, voting),
      ...(voting && ctx.feedback ? { feedback: this.mask(ctx.feedback) } : {}),
    });
    return {
      name: player.name, modelId: player.modelId,
      answer: (prompt, ctx) => player.answer(prompt, context(ctx)),
      answerFinal: (prompt, ctx) => player.answerFinal(prompt, context(ctx)),
      vote: (prompt, options, ctx) => player.vote(this.mask(prompt), options.map(o => this.mask(o)), context(ctx, true)),
    };
  }
}

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadCredentials, saveCredentials, type SeatCredentials } from "../src/credentials.js";
import { lookupRoom, RoomLookupError } from "../src/room.js";

describe("lookupRoom", () => {
  it("normalizes the room code and returns the typed body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(String(input)).toBe("https://directory.test/api/v2/rooms/ABCD");
      expect(new Headers(init?.headers).get("user-agent")).toBe("curl/8.7.1");
      return new Response(JSON.stringify({
        ok: true,
        body: { code: "ABCD", host: "play.test", appTag: "quiplash3", keepalive: true },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await expect(lookupRoom(" abcd ", { baseUrl: "https://directory.test/api/v2/rooms/", fetch }))
      .resolves.toMatchObject({ code: "ABCD", host: "play.test", appTag: "quiplash3" });
  });

  it("rejects unsuccessful and hostless envelopes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(
      JSON.stringify({ ok: false }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    await expect(lookupRoom("NOPE", { fetch })).rejects.toBeInstanceOf(RoomLookupError);
  });
});

describe("seat credentials", () => {
  it("persists and reloads all reconnect fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quiparena-credentials-"));
    const path = join(directory, "seats.json");
    const credentials: SeatCredentials = {
      room: "bexh",
      name: "REC1",
      userId: "user-id",
      deviceId: "device-id",
      id: 4,
      secret: "secret",
    };
    await saveCredentials(path, [credentials]);
    await expect(loadCredentials(path)).resolves.toEqual([{ ...credentials, room: "BEXH" }]);
  });
});

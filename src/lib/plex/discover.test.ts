import { describe, expect, it } from "vitest";
import { toTitlesMediaType } from "./discover";

// extractMediaContainerItems (constraint 14) moved to mediaContainer.ts —
// see mediaContainer.test.ts. discover.ts still re-exports it for backward
// compatibility, but the tests now live next to the implementation.

describe("toTitlesMediaType", () => {
  it("maps Plex's watchlist type to the app's media_type", () => {
    expect(toTitlesMediaType("movie")).toBe("movie");
    expect(toTitlesMediaType("show")).toBe("tv");
  });

  it("returns null for anything unrecognized rather than guessing", () => {
    expect(toTitlesMediaType("season")).toBeNull();
    expect(toTitlesMediaType("")).toBeNull();
  });
});

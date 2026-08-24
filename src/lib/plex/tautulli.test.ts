import { describe, expect, it } from "vitest";
import { joinTautulliByRatingKey, sanitizeHistoryRows } from "./tautulli";

describe("sanitizeHistoryRows (TS port of fetch_data.py's sanitize())", () => {
  it("coerces a column that's numeric except for blank strings", () => {
    const rows = sanitizeHistoryRows([
      { rating_key: "123", title: "A" },
      { rating_key: "", title: "B" },
      { rating_key: "456", title: "C" },
    ]);
    expect(rows[0].rating_key).toBe(123);
    expect(rows[1].rating_key).toBeNull();
    expect(rows[2].rating_key).toBe(456);
  });

  it("leaves a genuinely mixed string column as strings, not partially numeric", () => {
    const rows = sanitizeHistoryRows([
      { media_type: "episode" },
      { media_type: "movie" },
      { media_type: "" },
    ]);
    expect(rows[0].media_type).toBe("episode");
    expect(rows[1].media_type).toBe("movie");
    expect(rows[2].media_type).toBeNull();
  });

  it("passes through columns that are already numbers", () => {
    const rows = sanitizeHistoryRows([{ duration: 120 }, { duration: 90 }]);
    expect(rows[0].duration).toBe(120);
    expect(rows[1].duration).toBe(90);
  });

  it("handles an empty input without throwing", () => {
    expect(sanitizeHistoryRows([])).toEqual([]);
  });
});

describe("joinTautulliByRatingKey (join on rating_key + machine_identifier, never guid)", () => {
  it("matches on both rating_key and machine_identifier when both are present", () => {
    const rows = [
      { rating_key: "100", machine_identifier: "abc", guid: "com.plexapp.agents.imdb://tt1" },
      { rating_key: "100", machine_identifier: "xyz", guid: "com.plexapp.agents.imdb://tt1" },
    ];
    const matched = joinTautulliByRatingKey("100", "abc", rows);
    expect(matched).toHaveLength(1);
    expect(matched[0].machine_identifier).toBe("abc");
  });

  it("does not match a different rating_key even with the same machine_identifier", () => {
    const rows = [{ rating_key: "999", machine_identifier: "abc" }];
    expect(joinTautulliByRatingKey("100", "abc", rows)).toHaveLength(0);
  });

  it("falls back to rating_key alone when machine_identifier is absent from the row", () => {
    const rows = [{ rating_key: "100" }];
    expect(joinTautulliByRatingKey("100", "abc", rows)).toHaveLength(1);
  });
});

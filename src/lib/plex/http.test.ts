import { describe, expect, it } from "vitest";
import { parsePlexBody } from "./http";

describe("parsePlexBody", () => {
  it("parses JSON when Content-Type says json", () => {
    const result = parsePlexBody("application/json", '{"MediaContainer":{"size":1}}') as {
      MediaContainer: { size: number };
    };
    expect(result.MediaContainer.size).toBe(1);
  });

  it("parses JSON even when Content-Type doesn't say json but the body is valid JSON anyway", () => {
    const result = parsePlexBody("text/plain", '{"ok":true}') as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it("falls back to XML when the body isn't JSON at all (Accept header ignored by PMS)", () => {
    const xml =
      '<?xml version="1.0"?><MediaContainer size="1"><Video ratingKey="123" title="Foo"><Guid id="tmdb://603"/></Video></MediaContainer>';
    const result = parsePlexBody("text/xml", xml) as {
      MediaContainer: { Video: Array<{ ratingKey: string; title: string; Guid: Array<{ id: string }> }> };
    };
    expect(result.MediaContainer.Video[0].ratingKey).toBe("123");
    expect(result.MediaContainer.Video[0].Guid[0].id).toBe("tmdb://603");
  });

  it("wraps a single XML child element as a one-element array, not a bare object", () => {
    const xml = '<MediaContainer><Directory key="1" title="Movies" type="movie"/></MediaContainer>';
    const result = parsePlexBody("text/xml", xml) as {
      MediaContainer: { Directory: Array<{ key: string }> };
    };
    expect(Array.isArray(result.MediaContainer.Directory)).toBe(true);
    expect(result.MediaContainer.Directory).toHaveLength(1);
  });
});

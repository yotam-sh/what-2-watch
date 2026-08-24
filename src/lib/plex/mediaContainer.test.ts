import { describe, expect, it } from "vitest";
import { extractMediaContainerItems } from "./mediaContainer";

describe("extractMediaContainerItems (constraint 14)", () => {
  it("reads Metadata when present", () => {
    const container = { Metadata: [{ ratingKey: "1" }] };
    expect(extractMediaContainerItems(container)).toEqual([{ ratingKey: "1" }]);
  });

  it("falls back to Video when Metadata is absent — the case that broke other projects", () => {
    const container = { Video: [{ ratingKey: "2" }] };
    expect(extractMediaContainerItems(container)).toEqual([{ ratingKey: "2" }]);
  });

  it("falls back to Directory when both Metadata and Video are absent", () => {
    const container = { Directory: [{ ratingKey: "3" }] };
    expect(extractMediaContainerItems(container)).toEqual([{ ratingKey: "3" }]);
  });

  it("returns [] when none of the three are present", () => {
    expect(extractMediaContainerItems({})).toEqual([]);
  });

  it("returns [] for a null/undefined container", () => {
    expect(extractMediaContainerItems(null)).toEqual([]);
    expect(extractMediaContainerItems(undefined)).toEqual([]);
  });

  it("prefers Metadata over Video when both happen to be present", () => {
    const container = { Metadata: [{ ratingKey: "meta" }], Video: [{ ratingKey: "video" }] };
    expect(extractMediaContainerItems(container)).toEqual([{ ratingKey: "meta" }]);
  });

  it("wraps a bare single object (not an array) for any of the three keys", () => {
    const container = { Video: { ratingKey: "solo" } };
    expect(extractMediaContainerItems(container)).toEqual([{ ratingKey: "solo" }]);
  });

  it("treats an empty array as present — does not fall through to the next key", () => {
    const container = { Metadata: [], Video: [{ ratingKey: "should-not-appear" }] };
    expect(extractMediaContainerItems(container)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./relativeTime";

const NOW = new Date("2026-08-20T12:00:00Z");

describe("formatRelativeTime", () => {
  it("collapses anything under a minute to 'just now'", () => {
    expect(formatRelativeTime(new Date("2026-08-20T11:59:31Z"), NOW)).toBe("just now");
  });

  it("formats minutes with correct pluralization", () => {
    expect(formatRelativeTime(new Date("2026-08-20T11:59:00Z"), NOW)).toBe("1 minute ago");
    expect(formatRelativeTime(new Date("2026-08-20T11:45:00Z"), NOW)).toBe("15 minutes ago");
  });

  it("formats hours", () => {
    expect(formatRelativeTime(new Date("2026-08-20T09:00:00Z"), NOW)).toBe("3 hours ago");
  });

  it("formats days", () => {
    expect(formatRelativeTime(new Date("2026-08-17T12:00:00Z"), NOW)).toBe("3 days ago");
  });

  it("formats months", () => {
    expect(formatRelativeTime(new Date("2026-05-20T12:00:00Z"), NOW)).toBe("3 months ago");
  });

  it("formats years", () => {
    expect(formatRelativeTime(new Date("2024-08-20T12:00:00Z"), NOW)).toBe("2 years ago");
  });
});

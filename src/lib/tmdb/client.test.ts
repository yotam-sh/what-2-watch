import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchTmdbDetails,
  TmdbAuthError,
  TmdbNotFoundError,
  TmdbRequestError,
  tmdbGet,
} from "./client";

describe("tmdb client", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns parsed JSON on success", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 1, title: "Test" }), { status: 200 }) as unknown as Response,
    );
    const result = await tmdbGet<{ id: number; title: string }>("/movie/1");
    expect(result).toEqual({ id: 1, title: "Test" });
  });

  it("throws TmdbAuthError on 401 — the expected failure mode with the placeholder dev key", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ status_code: 7, status_message: "Invalid API key", success: false }),
        { status: 401 },
      ) as unknown as Response,
    );
    await expect(tmdbGet("/movie/1")).rejects.toThrow(TmdbAuthError);
  });

  it("TmdbAuthError message points the user at themoviedb.org", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("", { status: 401 }) as unknown as Response);
    await expect(tmdbGet("/movie/1")).rejects.toThrow(/themoviedb\.org/);
  });

  it("throws TmdbRequestError on other non-2xx statuses", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("", { status: 500 }) as unknown as Response);
    await expect(tmdbGet("/movie/1")).rejects.toThrow(TmdbRequestError);
  });

  it("retries on 429 and succeeds once the response turns 200", async () => {
    let call = 0;
    vi.mocked(global.fetch).mockImplementation(async () => {
      call += 1;
      if (call < 3) return new Response("", { status: 429, headers: { "Retry-After": "0" } }) as unknown as Response;
      return new Response(JSON.stringify({ id: 1 }), { status: 200 }) as unknown as Response;
    });
    const result = await tmdbGet<{ id: number }>("/movie/1");
    expect(result).toEqual({ id: 1 });
    expect(call).toBe(3);
  });

  it("gives up after repeated 429s", async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      new Response("", { status: 429, headers: { "Retry-After": "0" } }) as unknown as Response,
    );
    await expect(tmdbGet("/movie/1")).rejects.toThrow(TmdbRequestError);
  }, 10_000);

  it("fetchTmdbDetails translates a 404 into TmdbNotFoundError with id/mediaType context", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response("", { status: 404 }) as unknown as Response);
    await expect(fetchTmdbDetails(999999999, "movie")).rejects.toThrow(TmdbNotFoundError);
    await expect(fetchTmdbDetails(999999999, "movie")).rejects.toThrow(/999999999/);
  });

  it("fetchTmdbDetails requests credits and keywords via append_to_response", async () => {
    vi.mocked(global.fetch).mockResolvedValue(new Response(JSON.stringify({ id: 1 }), { status: 200 }) as unknown as Response);
    await fetchTmdbDetails(1, "movie");
    const [urlArg] = vi.mocked(global.fetch).mock.calls[0]!;
    const url = new URL(String(urlArg));
    expect(url.pathname).toBe("/3/movie/1");
    expect(url.searchParams.get("append_to_response")).toBe("credits,keywords");
    expect(url.searchParams.get("api_key")).toBeTruthy();
  });
});

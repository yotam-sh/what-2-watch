// ---------------------------------------------------------------------------
// Shared (tmdb_id, media_type) identity key, used across embed/score/cf/ltr
// wherever a title needs to be a Map key or Set member. One tiny module
// rather than each file rolling its own `${id}:${type}` string, so a future
// change to the key format only has one place to update.
// ---------------------------------------------------------------------------

export type MediaType = "movie" | "tv";

export interface TitleIdentity {
  tmdbId: number;
  mediaType: MediaType;
}

export function titleKey(t: TitleIdentity): string {
  return `${t.tmdbId}:${t.mediaType}`;
}

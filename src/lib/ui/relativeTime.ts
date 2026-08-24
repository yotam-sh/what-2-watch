// Pure "N units ago" formatter for the Rewatch/Continue/Watchlist browse
// screens (e.g. "8 months ago" next to a rewatch candidate). `now` is
// injectable so it's deterministic in tests.
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_MONTH = 30 * MS_PER_DAY;
const MS_PER_YEAR = 365 * MS_PER_DAY;

function pluralize(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < MS_PER_MINUTE) return "just now";
  if (diffMs < MS_PER_HOUR) return pluralize(Math.floor(diffMs / MS_PER_MINUTE), "minute");
  if (diffMs < MS_PER_DAY) return pluralize(Math.floor(diffMs / MS_PER_HOUR), "hour");
  if (diffMs < MS_PER_MONTH) return pluralize(Math.floor(diffMs / MS_PER_DAY), "day");
  if (diffMs < MS_PER_YEAR) return pluralize(Math.floor(diffMs / MS_PER_MONTH), "month");
  return pluralize(Math.floor(diffMs / MS_PER_YEAR), "year");
}

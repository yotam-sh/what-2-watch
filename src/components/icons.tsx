// Icon layer for the app. This used to be a hand-rolled stroke set — five
// glyphs weren't worth a dependency. The Comet re-skin changed that
// arithmetic: it needs a couple of dozen glyphs (empty-state illustrations,
// status markers, the checkbox tick, the offline screen), all at a
// consistent 2px stroke weight, which is exactly what Lucide is. Rather than
// rewrite every import site, this file stays as the single icon entry point
// and just re-exports Lucide under the names the app already uses.
//
// Anything not aliased here is imported straight from "lucide-react" at its
// own call site — this list is only for the glyphs that predate the switch.
//
// NOTE: Lucide's `History` was renamed `RotateCcwClock` in lucide-react v1;
// the old name no longer resolves and is not aliased by the package.
//
// NOTE: SpinnerIcon no longer spins by itself. The old hand-rolled component
// baked `animate-spin` into its own className; Lucide's LoaderCircle is just
// a static glyph, so every call site adds `animate-spin` explicitly.
export {
  Dices as DiceIcon,
  RotateCcwClock as HistoryIcon,
  Bookmark as BookmarkIcon,
  CirclePlay as PlayCircleIcon,
  SlidersHorizontal as SlidersIcon,
  Funnel as FilterIcon,
  X as CloseIcon,
  LoaderCircle as SpinnerIcon,
} from "lucide-react";

// better-sqlite3-multiple-ciphers ships its own bundled index.d.ts, but its
// package.json "exports" map has no "types" condition on the "." subpath —
// an upstream packaging bug, not something in this codebase — so
// TypeScript's bundler module resolution can't find it. (A tsconfig `paths`
// override was tried first and rejected: Next's bundler reads tsconfig
// `paths` too, and a mapping keyed on this exact package specifier silently
// redirected the *runtime* import to a type-only file, producing
// `new (void 0)(...)` in the compiled output instead of the real
// constructor — a much worse failure than the type error it "fixed".)
//
// This package is an API-compatible drop-in for `better-sqlite3` (same
// constructor, same Statement/Database shape, cipher support added via
// PRAGMA), so reusing @types/better-sqlite3's declarations here is accurate
// and avoids maintaining a parallel type surface by hand.
declare module "better-sqlite3-multiple-ciphers" {
  import Database from "better-sqlite3";
  export = Database;
}

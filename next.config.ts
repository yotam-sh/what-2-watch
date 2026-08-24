// Next.js build/runtime config.
//
// `output: "standalone"` traces the minimal set of files/deps needed to run
// the app and copies them into `.next/standalone`. Phase 6's Dockerfile runs
// that output directly (`node server.js`) instead of shipping the full
// node_modules tree into the image — that's the whole reason this is set
// here in Phase 1, even though nothing yet consumes it.
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Next.js bundles server-side deps by default, which breaks native addons
  // that resolve their .node binary path at runtime (they compute a path
  // relative to __dirname that only exists in the real node_modules tree,
  // not inside a bundle). Next ships a built-in externals list that already
  // covers plain `better-sqlite3`, but not this project's SQLCipher fork —
  // without this, `next dev`/`next build` fails to find the prebuilt binary.
  serverExternalPackages: ["better-sqlite3-multiple-ciphers"],
};

export default nextConfig;

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
  // Dev-only, and load-bearing for testing on a real phone. `next dev`
  // blocks cross-origin requests to /_next/* by default, and the hostname it
  // was started with is "localhost" — so opening http://<LAN-IP>:3000 from a
  // phone gets 403 on every client JS chunk. The HTML renders, so the app
  // *looks* fine, but React never hydrates and every button on every screen
  // is inert. It presents as "the sign-in button does nothing", which is
  // indistinguishable from an app bug until you check the network tab.
  // Next prints a "Blocked cross-origin request" warning naming the host —
  // add it here (or a wildcard covering the LAN) when the dev machine's IP
  // changes. Has no effect on `next build`/`next start` or the container.
  allowedDevOrigins: ["10.100.102.3", "192.168.*.*", "10.*.*.*"],
  // Next.js bundles server-side deps by default, which breaks native addons
  // that resolve their .node binary path at runtime (they compute a path
  // relative to __dirname that only exists in the real node_modules tree,
  // not inside a bundle). Next ships a built-in externals list that already
  // covers plain `better-sqlite3`, but not this project's SQLCipher fork —
  // without this, `next dev`/`next build` fails to find the prebuilt binary.
  serverExternalPackages: ["better-sqlite3-multiple-ciphers"],
};

export default nextConfig;

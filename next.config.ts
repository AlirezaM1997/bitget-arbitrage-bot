import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allows CI/verification builds to avoid colliding with a running dev server.
  distDir: process.env.NEXT_DIST_DIR?.trim() || ".next",
  // Native SQLite must be loaded by Node instead of being bundled into a
  // server chunk; this also keeps the platform-specific binding discoverable.
  serverExternalPackages: ["better-sqlite3"]
};
export default nextConfig;

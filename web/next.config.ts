import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // The repo root also has a package-lock.json (the scan engine). Pin Turbopack's
  // root to this app so it doesn't infer the monorepo root.
  turbopack: {
    root: path.join(__dirname),
  },
  // Mongoose is a server-only dependency; keep it external to the server bundle.
  serverExternalPackages: ["mongoose"],
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  // Serve/build from a configurable dir so a `next dev` run (e.g. the Playwright
  // suite) can't clobber a production build. Set NEXT_DIST_DIR=.next-prod in prod.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  webpack: (config) => {
    // The core data layer uses ESM-style `.js` specifiers for `.ts` sources.
    config.resolve.extensionAlias = {
      ".js": [".js", ".ts"],
      ".jsx": [".jsx", ".tsx"],
    };
    return config;
  },
};

export default nextConfig;

import type { NextConfig } from "next";

/** Proxy API + health to the real gateway so browser can use same-origin `/api/*` (avoids wrong port / CORS confusion). */
const gatewayOrigin = process.env.BEEBRIDGE_GATEWAY_ORIGIN ?? "http://127.0.0.1:4321";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  experimental: {
    // Next 15.5+ segment explorer can trigger webpack HMR/runtime errors
    // (e.g. "__webpack_modules__[moduleId] is not a function") in some setups.
    devtoolSegmentExplorer: false,
  },
  async rewrites() {
    return [
      { source: "/health", destination: `${gatewayOrigin}/health` },
      { source: "/api/:path*", destination: `${gatewayOrigin}/api/:path*` },
    ];
  },
};

export default nextConfig;

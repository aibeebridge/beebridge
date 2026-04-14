import type { NextConfig } from "next";

/**
 * Proxy API, health, and WebSocket to the real gateway so the browser can use a single origin
 * (same port as the Next app). SSH port-forward only that port; no separate WS port.
 */
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
      { source: "/ws", destination: `${gatewayOrigin}/ws` },
    ];
  },
};

export default nextConfig;

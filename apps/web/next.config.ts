import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Docker image: standalone server (apps/web/Dockerfile); trace files from the monorepo root.
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  transpilePackages: ['@storyzio/api-client', '@storyzio/contracts', '@storyzio/design-tokens'],
  poweredByHeader: false,
  // Covers / pages are already re-encoded WebP on the media CDN (API media pipeline): serve them as they are.
  images: { unoptimized: true },
  turbopack: {
    rules: {
      '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' },
    },
  },
  // Universal Links / App Links verification files (src/lib/app-links.ts); outside the locale proxy (dotted paths).
  async rewrites() {
    return [
      { source: '/.well-known/apple-app-site-association', destination: '/app-links/apple' },
      { source: '/.well-known/assetlinks.json', destination: '/app-links/android' },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;

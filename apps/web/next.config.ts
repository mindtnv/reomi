import type { NextConfig } from 'next';
import withSerwistInit from '@serwist/next';

export const nextConfig: NextConfig = {
  devIndicators: false,
  ...(process.env.NODE_ENV === 'development' && process.env.DESIGN_HOST
    ? { allowedDevOrigins: [process.env.DESIGN_HOST] }
    : {}),
  transpilePackages: ['@reomi/auth', '@reomi/shared', '@reomi/api'],
  // Produce a minimal runtime bundle at .next/standalone — consumed by the
  // web Dockerfile for a ~120 MB final image.
  output: 'standalone',
  // Keep old bookmarks working after the DNS/TLS-gated Reomi cutover.
  // Temporary redirect allows an image rollback without cached 308s.
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'neuronexus\\.mihailantonov\\.pro' }],
        destination: 'https://app.reomi.ru/:path*',
        permanent: false,
      },
    ];
  },
  // Media resolver (M2 Phase 2, plan C-1): a static reverse-proxy that maps the
  // stored relative token `/m/{uuid}` → the public S3 object `media/{uuid}`.
  // Next proxies server-side so the browser request stays same-origin, which is
  // why `img-src 'self'` in the CSP below still covers it — no CSP widening, no
  // DB lookup, no Bun hot path. The `:uuid` param is constrained to a strict
  // canonical UUID (C-6) so traversal / garbage tokens 404 at the route.
  async rewrites() {
    const mediaBase = process.env.NEXT_PUBLIC_MEDIA_BASE_URL ?? 'http://localhost:9000/neuronexus-media';
    return [
      {
        source: '/m/:uuid([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
        destination: `${mediaBase}/media/:uuid`,
      },
    ];
  },
  // Next 16 rewrites dev-time security headers; the prod config mirrors that
  // with an extra CSP that blocks everything except our own origins.
  async headers() {
    // The image upload (M2 Phase 4) is a RAW cross-origin POST from the browser
    // straight to S3/MinIO (presigned POST policy, bytes bypass Bun). Its origin
    // is the S3 endpoint, derived from NEXT_PUBLIC_MEDIA_BASE_URL — add it to
    // connect-src or the browser CSP-blocks the upload. img-src needs NO change:
    // images load same-origin via the `/m/:uuid` Next rewrite above.
    const mediaBase =
      process.env.NEXT_PUBLIC_MEDIA_BASE_URL ?? 'http://localhost:9000/neuronexus-media';
    let mediaOrigin = '';
    try {
      mediaOrigin = new URL(mediaBase).origin;
    } catch {
      mediaOrigin = '';
    }
    const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
    const connectSrc = ["'self'", apiOrigin, mediaOrigin].filter(Boolean).join(' ');
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Next.js still inlines a bootstrap script in production; unsafe-inline is
              // required until we opt into the CSP-nonce pipeline.
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              // M4 PDF reader: pdf.js boots its worker from a same-origin
              // `/_next/static/media/pdf.worker.min.mjs` chunk (covered by
              // script-src 'self'); `worker-src 'self' blob:` is explicit so the
              // worker is allowed under the strict `default-src 'self'` and the
              // pdf.js blob-wrapper fallback (cross-origin chunk path) still works.
              "worker-src 'self' blob:",
              `connect-src ${connectSrc}`,
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

// Inert PWA service worker for cross-engine install insurance (ralplan Phase B).
// CACHES NOTHING by design (server-of-truth, P2). @serwist/next auto-precaches
// the Next build output (/_next/static/* chunks + prerendered *.html); leaving
// that on would re-introduce PM-1 stale-JS risk. globPublicPatterns:[] only
// governs public/, NOT the build chunks — so we additionally force the precache
// manifest empty via a manifestTransform that drops every entry. This runs
// before serwist's internal URL-rewrite transform, which then maps over an
// empty array => self.__SW_MANIFEST === []. src/app/sw.ts adds no
// runtimeCaching / defaultCache. Disabled in dev so `next dev` is unaffected.
// NOTE: @serwist/next@9 ships only a webpack plugin (no Turbopack support yet),
// so the web `build`/`dev` scripts pin `--webpack` (Next 16 defaults to
// Turbopack). Revisit if/when serwist gains a Turbopack plugin.
const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  globPublicPatterns: [],
  // Force an empty precache manifest (caches nothing — strongest P2 defense).
  manifestTransforms: [() => ({ manifest: [], warnings: [] })],
  reloadOnOnline: false,
  disable: process.env.NODE_ENV === 'development',
});

export default withSerwist(nextConfig);

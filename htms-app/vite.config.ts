/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Content-Security-Policy for PRODUCTION only, injected as a <meta> at build time.
// Kept out of the dev path so it never blocks Vite's React preamble. frame-ancestors
// can't be set via meta, so framing is covered by X-Frame-Options in public/_headers.
const CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "img-src 'self' data: blob: https://*.supabase.co; " +
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "object-src 'none'; base-uri 'self'";

function cspMeta(): Plugin {
  return {
    name: 'inject-csp-meta',
    apply: 'build', // production build only — never runs for `vite`/`netlify dev`
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `  <meta http-equiv="Content-Security-Policy" content="${CSP}">\n  </head>`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), cspMeta()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'esbuild',
  },
  test: {
    environment: 'node',
    include: ['shared/**/*.test.ts', 'src/**/*.test.ts'],
  },
});

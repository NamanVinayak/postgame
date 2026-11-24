/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { buildDate, commitSha } from './scripts/build-info.mjs';

export default defineConfig({
  // The version line (src/components/AppVersion.tsx): which copy of the app a device runs.
  define: {
    __APP_COMMIT__: JSON.stringify(commitSha()),
    __APP_BUILD_DATE__: JSON.stringify(buildDate()),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registration lives in src/pwa/updates.ts (update checks + a safe reload into a new
      // version). Never go back to the injected registration-only registerSW.js.
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icon.svg'],
      manifest: {
        name: 'Postgame — Free Chess Review',
        short_name: 'Postgame',
        description: 'Free game review for the games you play on Chess.com.',
        theme_color: '#1b1a17',
        background_color: '#1b1a17',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // A new version takes control as soon as it is installed; src/pwa/updates.ts then
        // reloads the page into it. Set explicitly: with injectRegister false the plugin
        // stops adding these for 'autoUpdate', and new versions would wait forever.
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,svg,wasm}'],
        // The single-threaded Stockfish wasm is ~7 MB; precache it for offline analysis.
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        navigateFallbackDenylist: [/\/stockfish\//],
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    css: false,
    // coach/ is a separate package with its own vitest config; keep it out of the root run.
    exclude: [...configDefaults.exclude, 'coach/**'],
  },
});

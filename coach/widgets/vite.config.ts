import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds the board widget into ONE self-contained file, coach/dist/board.html, with the
// MCP Apps client and React bundled inline (MCP App frames block remote scripts by default).
// Paths are resolved from this file, not the working directory.
const boardDir = fileURLToPath(new URL('./board/', import.meta.url));
const distDir = fileURLToPath(new URL('../dist/', import.meta.url));

export default defineConfig({
  root: boardDir,
  plugins: [react(), viteSingleFile({ outputFileName: 'board.html' })],
  build: {
    outDir: distDir,
    emptyOutDir: true,
  },
});

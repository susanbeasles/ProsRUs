import { defineConfig } from 'vite';

/** The Worker serves only /owner/job-stack and /owner/job-stack/assets/<file> with file names matching this pattern. */
export const ASSET_NAME = /^[A-Za-z0-9_.-]+$/;
const safe = (name: string) => name.replace(/[^A-Za-z0-9_.-]/g, '_');

export default defineConfig({
  root: 'dashboard',
  base: '/owner/job-stack/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        sanitizeFileName: safe,
      },
    },
  },
});

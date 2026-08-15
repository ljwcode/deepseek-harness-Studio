import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  build: {
    outDir: 'dist/main',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: src('./src/main/main.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['electron', /^node:/],
    },
  },
})

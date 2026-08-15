import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  build: {
    outDir: 'dist/preload',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: src('./src/preload/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    rollupOptions: {
      external: ['electron'],
    },
  },
})

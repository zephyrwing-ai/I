import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(root, 'out/main'),
      lib: { entry: resolve(root, 'shell/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(root, 'out/preload'),
      lib: { entry: resolve(root, 'shell/preload/index.ts') },
      rollupOptions: { output: { format: 'cjs' } }
    }
  },
  renderer: {
    root: resolve(root, 'frontend'),
    plugins: [react()],
    build: {
      outDir: resolve(root, 'out/renderer'),
      rollupOptions: {
        input: resolve(root, 'frontend/index.html')
      }
    }
  }
})

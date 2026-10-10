import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import applicationMetadata from './package.json'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(root, 'out/main'),
      lib: {
        entry: {
          index: resolve(root, 'shell/main/index.ts'),
          'canvas-cli': resolve(root, 'canvas/cli/index.ts')
        }
      }
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
    plugins: [
      react(),
      {
        name: 'application-title',
        transformIndexHtml: (html) => html.replace('%APP_NAME%', applicationMetadata.productName)
      }
    ],
    css: {
      preprocessorOptions: {
        scss: {
          quietDeps: true,
          silenceDeprecations: ['import']
        }
      }
    },
    resolve: {
      alias: {
        '@agent-studio/canvas-editor': resolve(root, 'canvas/engine/editor'),
        '@agent-studio/canvas-utils': resolve(root, 'canvas/engine/utils'),
        '@agent-studio/canvas-math': resolve(root, 'canvas/engine/math')
      }
    },
    build: {
      outDir: resolve(root, 'out/renderer'),
      rollupOptions: {
        input: resolve(root, 'frontend/index.html')
      }
    }
  }
})

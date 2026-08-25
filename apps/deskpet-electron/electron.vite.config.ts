import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({
      exclude: ['@deskpet/core', '@deskpet/llm-openai', '@deskpet/memory', '@deskpet/tools'],
    })],
    build: {
      outDir: resolve(__dirname, 'dist/main'),
      rollupOptions: {
        external: ['electron'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'memory-v4-shadow-worker': resolve(__dirname, 'src/main/memory-v4-shadow-worker.ts'),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    build: {
      outDir: resolve(__dirname, 'dist/preload'),
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } },
    },
  },
  renderer: {
    // Packaged Electron pages are loaded with file://. Relative asset URLs keep
    // Vite from resolving /assets against the drive root (for example D:/assets).
    base: './',
    build: { outDir: resolve(__dirname, 'dist/renderer') },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [vue()],
  },
})

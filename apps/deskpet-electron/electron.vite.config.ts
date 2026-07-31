import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    build: { outDir: 'dist/main', rollupOptions: { external: ['electron'] } },
  },
  preload: {
    build: { outDir: 'dist/preload', rollupOptions: { external: ['electron'] } },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
      },
    },
    plugins: [vue()],
  },
})
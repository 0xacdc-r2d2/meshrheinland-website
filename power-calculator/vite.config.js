import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: '/power-calc/',
  build: {
    outDir: '../static/power-calc',
    emptyOutDir: true,
  },
})

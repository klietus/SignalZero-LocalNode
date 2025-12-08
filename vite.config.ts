import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    resolve: {
      alias: {
        // Polyfill buffer for browser
        buffer: 'buffer',
      },
    },
    define: {
      'process.env.API_KEY': JSON.stringify(env.API_KEY),
      // Polyfill global for libraries expecting Node.js global
      global: 'window',
    },
    optimizeDeps: {
      include: ['buffer', 'long'],
    },
    server: {
      port: 3000,
      open: true
    }
  };
});
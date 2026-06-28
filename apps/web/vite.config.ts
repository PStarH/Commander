import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      // Proxy API requests to the backend during development
      // This avoids CORS issues and matches production behavior
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/ready': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/metrics': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/system': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/projects': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/missions': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/runtime': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/a2a': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/mcp': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/react-router-dom')
          )
            return 'vendor';
          if (id.includes('node_modules/recharts')) return 'charts';
          if (id.includes('node_modules/@xyflow') || id.includes('node_modules/dagre'))
            return 'flow';
        },
      },
    },
  },
});

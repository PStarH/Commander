import { defineConfig } from 'vite';

export default defineConfig({
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

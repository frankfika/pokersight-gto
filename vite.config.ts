import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const test = {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  };
  const env = loadEnv(mode, '.', '');
  return {
    test,
    server: {
      port: 3000,
      host: '0.0.0.0',
      strictPort: true,
    },
    plugins: [react()],
    define: {
      'process.env.WS_PROXY_PORT': JSON.stringify(env.WS_PROXY_PORT || '3301')
    },
  };
});

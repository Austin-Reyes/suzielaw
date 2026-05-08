import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendPort = env.SUZIELAW_PORT || '17501';
  const clientPort = parseInt(env.SUZIELAW_CLIENT_PORT || '17502', 10);
  const upstreamRoot = resolve(__dirname, '../../../../agents');

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@teamsuzie/ui': fileURLToPath(new URL('../../../../agents/packages/ui/src/index.ts', import.meta.url)),
      },
    },
    server: {
      port: clientPort,
      fs: {
        allow: [
          resolve(__dirname, '../../../..'),
          upstreamRoot,
        ],
      },
      proxy: {
        '/api': `http://localhost:${backendPort}`,
      },
    },
    build: {
      outDir: 'dist',
    },
  };
});

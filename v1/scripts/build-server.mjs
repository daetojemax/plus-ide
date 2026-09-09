import { build } from 'esbuild';
await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist-server/server.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
});

import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createApp } from './app';

async function main() {
  const dataDir =
    process.env.PLUS_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'Plus', 'v1');
  const port = Number(process.env.PLUS_PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PLUS_PORT');
  const { app } = await createApp({
    dataDir,
    staticDir: process.env.PLUS_STATIC_DIR || resolve('dist'),
  });
  await app.listen({ host: '127.0.0.1', port });
  console.log(`Plus server ready on http://127.0.0.1:${port}`);
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => void close());
  process.on('SIGINT', () => void close());
  const parent = Number(process.env.PLUS_PARENT_PID);
  if (parent)
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        void close();
      }
    }, 3000).unref();
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Server startup failed');
  process.exit(1);
});

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const env = {
  ...process.env,
  PLUS_DATA_DIR: process.env.PLUS_DATA_DIR || resolve('.data'),
  PLUS_PORT: process.env.PLUS_PORT || '4317',
};
console.log(`Development data: ${env.PLUS_DATA_DIR}`);
console.log(
  'For owner access in the browser, use owner.key in that directory. The desktop app signs in automatically.',
);
const children = [
  spawn(resolve('node_modules/.bin/tsx'), ['watch', 'server/index.ts'], { stdio: 'inherit', env }),
  spawn(resolve('node_modules/.bin/vite'), ['--host', '127.0.0.1'], { stdio: 'inherit', env }),
];
let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  for (const child of children) child.kill('SIGTERM');
}
for (const child of children)
  child.on('exit', () => {
    stop();
  });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

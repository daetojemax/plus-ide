import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const env = { ...process.env };
const local = resolve('.toolchains');
if (existsSync(`${local}/cargo/bin/cargo`)) {
  env.CARGO_HOME = `${local}/cargo`;
  env.RUSTUP_HOME = `${local}/rustup`;
  env.PATH = `${local}/cargo/bin:${env.PATH}`;
}
execFileSync('npm', ['run', 'build'], { stdio: 'inherit', env });
execFileSync('npm', ['run', 'prepare:desktop'], { stdio: 'inherit', env });
const child = spawn(resolve('node_modules/.bin/tauri'), process.argv.slice(2), {
  stdio: 'inherit',
  env,
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

import { mkdir, copyFile, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

if (process.platform !== 'darwin')
  throw new Error('The v1 desktop package currently targets macOS.');
const target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
await mkdir('src-tauri/binaries', { recursive: true });
await mkdir('src-tauri/resources', { recursive: true });
const executable = join('src-tauri/binaries', `plus-node-${target}`);
await copyFile(process.execPath, executable);
await chmod(executable, 0o755);
await copyFile('dist-server/server.cjs', 'src-tauri/resources/server.cjs');
const codexPackage = `node_modules/@openai/codex-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}/vendor/${target}/bin`;
for (const [source, name] of [
  ['codex', 'plus-codex'],
  ['codex-code-mode-host', 'codex-code-mode-host'],
]) {
  const destination = join('src-tauri/binaries', `${name}-${target}`);
  await copyFile(join(codexPackage, source), destination);
  await chmod(destination, 0o755);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', destination], { stdio: 'inherit' });
}
// Ad-hoc signing allows the copied Node executable to run in a local app bundle.
execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', executable], { stdio: 'inherit' });
console.log(`Prepared Node runtime and backend for ${target}.`);

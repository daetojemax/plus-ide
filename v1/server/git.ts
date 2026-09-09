import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitState } from '../shared/protocol';

const exec = promisify(execFile);
export async function gitState(cwd: string): Promise<GitState> {
  const options = {
    cwd,
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  };
  try {
    const [branch, status, unstaged, staged] = await Promise.all([
      exec('git', ['symbolic-ref', '--short', 'HEAD'], options).catch(() => ({ stdout: 'HEAD' })),
      exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], options),
      exec('git', ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--', '.'], options),
      exec(
        'git',
        ['--no-pager', 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--', '.'],
        options,
      ),
    ]);
    const records = status.stdout.split('\0');
    const files = [];
    for (let i = 0; i < records.length; i++) {
      const line = records[i];
      if (!line) continue;
      const code = line.slice(0, 2);
      files.push({ path: line.slice(3), status: code.trim() });
      if (/[RC]/.test(code)) i++;
    }
    const diff = `${staged.stdout}${unstaged.stdout}`;
    return {
      available: true,
      branch: branch.stdout.trim(),
      files,
      diff: diff.slice(0, 150_000),
      truncated: diff.length > 150_000,
    };
  } catch {
    return { available: false, branch: '', files: [], diff: '', truncated: false };
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// The vendor protocol is decoded at this boundary; application models remain typed.
export type RpcObject = Record<string, any>;
export function describeCodexError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message);
    message = parsed.error?.message || parsed.message || message;
  } catch {}
  if (message.includes('requires a newer version'))
    return 'Выбранная модель требует более новой версии Codex. Обновите Plus или выберите другую модель.';
  return message.slice(0, 3000);
}
export interface AgentConnection {
  call(method: string, params?: RpcObject): Promise<any>;
  notify(method: string, params?: RpcObject): void;
  respond(id: number | string, result: RpcObject): void;
  reject(id: number | string, message: string): void;
  on(event: 'notification' | 'request' | 'failure', listener: (...args: any[]) => void): this;
  close(): void;
}

export class CodexConnection extends EventEmitter implements AgentConnection {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private closed = false;
  private pending = new Map<
    number,
    { resolve: (data: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(cwd: string, binary = process.env.CODEX_BIN || 'codex') {
    super();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('PLUS_')),
    );
    this.child = spawn(binary, ['app-server'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      if (line.length > 8_000_000) return;
      try {
        const message = JSON.parse(line) as RpcObject;
        if (message.method)
          this.emit(message.id === undefined ? 'notification' : 'request', message);
        else if (typeof message.id === 'number') {
          const waiting = this.pending.get(message.id);
          if (!waiting) return;
          this.pending.delete(message.id);
          clearTimeout(waiting.timer);
          if (message.error)
            waiting.reject(new Error(String(message.error.message || 'Ошибка Codex')));
          else waiting.resolve(message.result);
        }
      } catch {
        /* non-protocol output cannot become an app event */
      }
    });
    this.child.stderr.resume();
    this.child.on('error', (error) =>
      this.fail(new Error(`Не удалось запустить Codex: ${error.message}`)),
    );
    this.child.on('exit', (code) => {
      if (!this.closed) this.fail(new Error(`Процесс Codex завершился (${code ?? 'signal'}).`));
    });
    this.child.stdin.on('error', (error) => {
      if (!this.closed) this.fail(error);
    });
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('failure', error);
  }
  call(method: string, params: RpcObject = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Соединение с Codex закрыто.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex не ответил на ${method} за 60 секунд.`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  private write(data: RpcObject) {
    if (!this.closed && this.child.stdin.writable)
      this.child.stdin.write(`${JSON.stringify(data)}\n`);
  }
  notify(method: string, params: RpcObject = {}) {
    this.write({ method, params });
  }
  respond(id: number | string, result: RpcObject) {
    this.write({ id, result });
  }
  reject(id: number | string, message: string) {
    this.write({ id, error: { code: -32601, message } });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Запуск остановлен.'));
    }
    this.pending.clear();
    const pid = this.child.pid;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (pid && process.platform !== 'win32') process.kill(-pid, signal);
        else this.child.kill(signal);
      } catch {}
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 2000);
    timer.unref();
    this.child.once('exit', () => clearTimeout(timer));
  }
}

export async function initialize(connection: AgentConnection) {
  await connection.call('initialize', {
    clientInfo: { name: 'plus', title: 'Plus', version: '0.1.0' },
    capabilities: { experimentalApi: false },
  });
  connection.notify('initialized');
}

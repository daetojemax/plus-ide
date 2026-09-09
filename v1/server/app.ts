import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import serveStatic from '@fastify/static';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { realpath, stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import { Store, hash, now, type Session } from './store';
import { Scheduler } from './scheduler';
import { importAgentImages } from './agent-images';
import { CodexConnection, initialize, type AgentConnection } from './codex';
import { gitState } from './git';
import type {
  AppEvent,
  Attachment,
  Message,
  ModelOption,
  Snapshot,
  Task,
} from '../shared/protocol';

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export interface AppOptions {
  dataDir: string;
  staticDir?: string;
  agentFactory?: (cwd: string) => AgentConnection;
}

export async function createApp(options: AppOptions) {
  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024, trustProxy: false });
  const store = new Store(options.dataDir);
  store.recover();
  for (const project of store.projects()) {
    for (const message of store.messages(project.id)) {
      const restored = importAgentImages(store, message);
      if (restored !== message) store.addMessage(restored);
    }
  }
  const clients = new Map<WebSocket, { person: Session; credential: string; owner: boolean }>();
  const publish = (event: AppEvent) => {
    for (const [socket, client] of clients) {
      if (!client.owner && !store.session(client.credential)) {
        socket.close(4001, 'Session revoked');
        clients.delete(socket);
        continue;
      }
      if (client.person.role === 'owner' || client.person.projectId === event.projectId) {
        if (socket.bufferedAmount > 2 * 1024 * 1024) {
          socket.close(4008, 'Reconnect to resync');
          continue;
        }
        if (socket.readyState === 1) socket.send(JSON.stringify(event));
      }
    }
  };
  const changed = (id: string) => publish(store.event(id, 'changed'));
  const scheduler = new Scheduler(store, publish, options.agentFactory);
  const sameToken = (value: string) =>
    timingSafeEqual(Buffer.from(hash(value)), Buffer.from(hash(store.ownerToken)));
  const identify = (request: FastifyRequest, tokenOverride?: string): Session => {
    const bearer = tokenOverride || request.headers.authorization?.replace(/^Bearer /, '');
    if (bearer && sameToken(bearer)) return store.owner();
    const guest = store.session(request.cookies.plus_session || '');
    if (guest) return guest;
    throw new HttpError(401, 'Войдите в приложение или откройте приглашение.');
  };
  const owner = (request: FastifyRequest) => {
    const person = identify(request);
    if (person.role !== 'owner') throw new HttpError(403, 'Это действие доступно владельцу.');
    return person;
  };
  const access = (request: FastifyRequest, id: string) => {
    const person = identify(request);
    const project = store.project(id);
    if (!project || (person.role !== 'owner' && person.projectId !== id))
      throw new HttpError(404, 'Проект не найден.');
    return { person, project };
  };
  const allowedOrigin = (origin: string) => {
    const permitted = new Set([
      'http://localhost:1420',
      'http://127.0.0.1:1420',
      'http://localhost:4317',
      'http://127.0.0.1:4317',
      'http://tauri.localhost',
      'https://tauri.localhost',
      'tauri://localhost',
    ]);
    if (process.env.PLUS_PORT) permitted.add(`http://127.0.0.1:${process.env.PLUS_PORT}`);
    const publicUrl = store.setting('publicUrl');
    if (publicUrl) permitted.add(publicUrl);
    return permitted.has(origin);
  };
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  const buckets = new Map<string, { time: number; count: number }>();
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigin(origin)) throw new HttpError(403, 'Источник запроса не разрешён.');
    if (origin) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Credentials', 'true');
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
    if (request.url.startsWith('/api')) reply.header('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS')
      return reply
        .header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Plus-Client')
        .header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
        .status(204)
        .send();
    if (!['GET', 'HEAD'].includes(request.method) && request.headers['x-plus-client'] !== '1')
      throw new HttpError(403, 'Отсутствует заголовок клиента.');
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      request.cookies.plus_session &&
      !origin &&
      !request.headers.authorization
    )
      throw new HttpError(403, 'Отсутствует Origin.');
    if (request.url.startsWith('/api/invitations/') || request.url === '/api/join') {
      const key = request.ip;
      let bucket = buckets.get(key);
      if (!bucket || Date.now() - bucket.time > 60_000) {
        bucket = { time: Date.now(), count: 0 };
        if (buckets.size > 10_000) buckets.clear();
        buckets.set(key, bucket);
      }
      if (++bucket.count > 60)
        throw new HttpError(429, 'Слишком много запросов. Попробуйте через минуту.');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: error.issues[0]?.message || 'Проверьте введённые данные.' });
    const e = error as Error & { statusCode?: number; code?: string };
    if (e.code?.startsWith('ERR_SQLITE'))
      return reply.code(409).send({ error: 'Этот проект или сообщение уже существует.' });
    return reply.code(e.statusCode || 500).send({
      error:
        e.statusCode && e.statusCode < 500
          ? e.message
          : 'Не удалось обработать запрос. Проверьте состояние локального сервера.',
    });
  });
  app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }));
  app.get('/api/snapshot', async (request) => {
    const person = identify(request);
    const projects = store
      .projects()
      .filter((p) => person.role === 'owner' || p.id === person.projectId);
    const snapshot: Snapshot = {
      me: person,
      projects,
      messages: projects.flatMap((p) => store.messages(p.id)),
      tasks: projects.flatMap((p) => store.tasks(p.id)),
      members: Object.fromEntries(projects.map((p) => [p.id, store.members(p.id)])),
      approvals: scheduler.approvals().filter((a) => projects.some((p) => p.id === a.projectId)),
      settings: { publicUrl: store.setting('publicUrl'), ownerName: store.owner().name },
      cursor: store.cursor(),
    };
    return {
      ...snapshot,
      modes: Object.fromEntries(projects.map((p) => [p.id, store.mode(p.id)])),
    };
  });
  app.post('/api/projects', async (request) => {
    owner(request);
    const body = z
      .object({ name: z.string().trim().max(80).optional(), path: z.string().min(1).max(4096) })
      .parse(request.body);
    if (!isAbsolute(body.path)) throw new HttpError(400, 'Выберите абсолютный путь к папке.');
    const path = await realpath(body.path).catch(() => {
      throw new HttpError(400, 'Папка не найдена.');
    });
    if (!(await stat(path)).isDirectory()) throw new HttpError(400, 'Выберите папку проекта.');
    const project = store.createProject(body.name || basename(path), path);
    changed(project.id);
    return project;
  });
  app.patch('/api/projects/:id/mode', async (request) => {
    owner(request);
    const { id } = request.params as { id: string };
    access(request, id);
    if (store.tasks(id).some((t) => ['running', 'waiting'].includes(t.status)))
      throw new HttpError(409, 'Сначала остановите текущую задачу, чтобы изменить её разрешения.');
    const { mode } = z.object({ mode: z.enum(['read', 'edit']) }).parse(request.body);
    store.setMode(id, mode);
    changed(id);
    return { mode };
  });
  app.post('/api/projects/:id/messages', async (request) => {
    const { id } = request.params as { id: string };
    const { person } = access(request, id);
    const body = z
      .object({
        id: z.string().uuid(),
        text: z.string().trim().max(30_000),
        agent: z.boolean(),
        attachments: z.array(z.string().uuid()).max(4).default([]),
        model: z.string().max(100).nullable().optional(),
      })
      .parse(request.body);
    if (!body.text && !body.attachments.length)
      throw new HttpError(400, 'Напишите сообщение или прикрепите изображение.');
    const existing = store.message(body.id);
    if (existing) {
      if (existing.projectId !== id || existing.authorId !== person.id)
        throw new HttpError(409, 'Идентификатор сообщения уже используется.');
      return existing;
    }
    const attachments = body.attachments.map((key) => {
      const a = store.attachment(key);
      if (!a || a.projectId !== id || a.ownerId !== person.id)
        throw new HttpError(400, 'Вложение недоступно.');
      return { id: a.id, name: a.name, mime: a.mime, size: a.size };
    });
    if (
      body.agent &&
      store.tasks(id).filter((t) => ['queued', 'running', 'waiting'].includes(t.status)).length >=
        20
    )
      throw new HttpError(429, 'В очереди уже 20 задач. Дождитесь завершения.');
    const taskId = body.agent ? randomUUID() : null;
    const message: Message = {
      id: body.id,
      projectId: id,
      author: person.name,
      authorId: person.id,
      kind: 'human',
      text: body.text,
      createdAt: now(),
      taskId,
      attachments,
    };
    // Message and queued task must either both be durable or neither.
    store.db.exec('BEGIN IMMEDIATE');
    let task: Task | undefined;
    try {
      store.addMessage(message);
      if (taskId) {
        task = {
          id: taskId,
          projectId: id,
          messageId: message.id,
          status: 'queued',
          createdAt: now(),
          activity: 'В очереди',
          error: null,
          model: body.model || null,
          mode: store.mode(id),
        };
        store.saveTask(task);
      }
      store.db.exec('COMMIT');
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
    changed(id);
    if (task) scheduler.enqueue(task);
    return message;
  });
  app.post('/api/tasks/:id/stop', async (request) => {
    const { id } = request.params as { id: string };
    const task = store.task(id);
    if (!task) throw new HttpError(404, 'Задача не найдена.');
    const { person } = access(request, task.projectId);
    const author = store.message(task.messageId)?.authorId;
    if (person.role !== 'owner' && person.id !== author)
      throw new HttpError(403, 'Можно остановить только свою задачу.');
    await scheduler.cancel(id);
    return { ok: true };
  });
  app.post('/api/approvals/:id', async (request) => {
    owner(request);
    const { id } = request.params as { id: string };
    const { allow } = z.object({ allow: z.boolean() }).parse(request.body);
    if (!scheduler.decide(id, allow)) throw new HttpError(409, 'Запрос уже закрыт.');
    return { ok: true };
  });
  app.post('/api/projects/:id/invitations', async (request) => {
    owner(request);
    const { id } = request.params as { id: string };
    access(request, id);
    const invitation = store.invite(id);
    return { token: invitation, expiresIn: 86400 };
  });
  app.delete('/api/projects/:id/invitations', async (request) => {
    owner(request);
    const { id } = request.params as { id: string };
    access(request, id);
    store.revokeInvites(id);
    return { ok: true };
  });
  app.get('/api/invitations/:token', async (request) => {
    const { token } = request.params as { token: string };
    if (token.length > 100) throw new HttpError(404, 'Приглашение недействительно.');
    const project = store.inviteProject(token);
    if (!project) throw new HttpError(404, 'Приглашение истекло или уже использовано.');
    return { name: project.name, owner: store.owner().name };
  });
  app.post('/api/join', async (request, reply) => {
    const body = z
      .object({ token: z.string().min(30).max(100), name: z.string().trim().min(1).max(60) })
      .parse(request.body);
    const result = store.join(body.token, body.name);
    if (!result) throw new HttpError(404, 'Приглашение истекло или уже использовано.');
    const secure = request.headers.origin?.startsWith('https://') || false;
    reply.setCookie('plus_session', result.raw, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: '/',
      maxAge: 30 * 24 * 60 * 60,
    });
    changed(result.person.projectId!);
    return { ok: true, projectId: result.person.projectId };
  });
  app.delete('/api/projects/:id/members/:memberId', async (request) => {
    owner(request);
    const { id, memberId } = request.params as { id: string; memberId: string };
    access(request, id);
    store.revoke(id, memberId);
    for (const task of store.tasks(id)) {
      if (store.message(task.messageId)?.authorId === memberId) await scheduler.cancel(task.id);
    }
    changed(id);
    return { ok: true };
  });
  app.post('/api/logout', async (request, reply) => {
    reply.clearCookie('plus_session', { path: '/' });
    return { ok: true };
  });
  app.patch('/api/settings', async (request) => {
    owner(request);
    const body = z
      .object({
        publicUrl: z.string().trim().max(2048),
        ownerName: z.string().trim().min(1).max(60),
      })
      .parse(request.body);
    let publicUrl = '';
    if (body.publicUrl) {
      const url = new URL(body.publicUrl);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        throw new HttpError(
          400,
          'Укажите HTTPS-адрес сервера без пути, например https://mac.tailnet.ts.net',
        );
      publicUrl = url.origin;
    }
    store.setSetting('publicUrl', publicUrl);
    store.setSetting('ownerName', body.ownerName);
    for (const p of store.projects()) changed(p.id);
    return { ok: true };
  });
  app.get('/api/projects/:id/git', async (request) => {
    const { id } = request.params as { id: string };
    const { project } = access(request, id);
    return gitState(project.path);
  });
  app.post('/api/projects/:id/attachments', async (request) => {
    const { id } = request.params as { id: string };
    const { person } = access(request, id);
    const body = z
      .object({
        name: z.string().max(200),
        mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        base64: z.string().max(9_000_000),
      })
      .parse(request.body);
    const data = Buffer.from(body.base64, 'base64');
    if (data.length > 6 * 1024 * 1024 || data.length < 12)
      throw new HttpError(400, 'Изображение должно быть меньше 6 МБ.');
    const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpg = data[0] === 255 && data[1] === 216 && data[2] === 255;
    const webp =
      data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
    if (!(body.mime === 'image/png' ? png : body.mime === 'image/jpeg' ? jpg : webp))
      throw new HttpError(400, 'Содержимое не соответствует формату изображения.');
    const attachment: Attachment = {
      id: randomUUID(),
      name: basename(body.name) || 'image',
      mime: body.mime,
      size: data.length,
    };
    await writeFile(join(store.directory, 'attachments', attachment.id), data, { mode: 0o600 });
    store.addAttachment(id, person.id, attachment);
    return attachment;
  });
  app.get('/api/attachments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const attachment = store.attachment(id);
    if (!attachment) throw new HttpError(404, 'Вложение не найдено.');
    access(request, attachment.projectId);
    return reply
      .type(attachment.mime)
      .header('Content-Disposition', 'inline')
      .send(await readFile(join(store.directory, 'attachments', attachment.id)));
  });
  let modelCache: ModelOption[] = [];
  app.get('/api/models', async (request) => {
    identify(request);
    if (modelCache.length) return modelCache;
    const connection = options.agentFactory
      ? options.agentFactory(process.cwd())
      : new CodexConnection(process.cwd());
    connection.on('failure', () => {});
    try {
      await initialize(connection);
      const response = await connection.call('model/list', {});
      modelCache = (response.data || []).map(
        (m: { id: string; model?: string; displayName?: string; isDefault?: boolean }) => ({
          id: m.model || m.id,
          name: m.displayName || m.id,
          isDefault: !!m.isDefault,
        }),
      );
      return modelCache;
    } catch {
      throw new HttpError(503, 'Codex недоступен. Проверьте установку CLI и вход в аккаунт.');
    } finally {
      connection.close();
    }
  });
  app.get('/api/events', { websocket: true }, (socket, request) => {
    const timeout = setTimeout(() => socket.close(4001, 'Authentication required'), 5000);
    socket.once('message', (raw) => {
      try {
        const body = z
          .object({
            type: z.literal('authenticate'),
            token: z.string().max(200).optional(),
            after: z.number().int().nonnegative().optional(),
          })
          .parse(JSON.parse(raw.toString()));
        const person = identify(request, body.token);
        clearTimeout(timeout);
        clients.set(socket, {
          person,
          credential: request.cookies.plus_session || '',
          owner: person.role === 'owner',
        });
        // A full snapshot replaces replay after every reconnect, including missed deltas.
        socket.send(JSON.stringify({ type: 'ready', cursor: store.cursor() }));
      } catch {
        clearTimeout(timeout);
        socket.close(4001, 'Unauthorized');
      }
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      clients.delete(socket);
    });
    socket.on('error', () => {
      clearTimeout(timeout);
      clients.delete(socket);
    });
  });
  const heartbeat = setInterval(() => {
    for (const socket of clients.keys()) if (socket.readyState === 1) socket.ping();
  }, 25_000);
  heartbeat.unref();
  if (options.staticDir && existsSync(options.staticDir)) {
    await app.register(serveStatic, { root: options.staticDir, index: 'index.html' });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Маршрут не найден.' })
        : reply.sendFile('index.html'),
    );
  }
  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    for (const socket of clients.keys()) socket.close(1001);
    await scheduler.shutdown();
    store.close();
  });
  return { app, store, scheduler };
}

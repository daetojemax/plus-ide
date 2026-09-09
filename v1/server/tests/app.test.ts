import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../app';
import { Store, now } from '../store';
import { importAgentImages } from '../agent-images';
import type { AgentConnection } from '../codex';

class FakeAgent extends EventEmitter implements AgentConnection {
  calls: Array<{ method: string; params: any }> = [];
  closed = false;
  threadId = randomUUID();
  turnId = randomUUID();
  answers: any[] = [];
  async call(method: string, params: any = {}) {
    this.calls.push({ method, params });
    if (method === 'initialize') return {};
    if (method === 'thread/start' || method === 'thread/resume') {
      if (params.threadId) this.threadId = params.threadId;
      return { thread: { id: this.threadId } };
    }
    if (method === 'turn/start') return { turn: { id: this.turnId } };
    if (method === 'model/list') return { data: [{ id: 'test-model', displayName: 'Test model' }] };
    return {};
  }
  notify() {}
  respond(id: number | string, result: any) {
    this.answers.push({ id, result });
  }
  reject(id: number | string, message: string) {
    this.answers.push({ id, error: message });
  }
  close() {
    this.closed = true;
  }
  finish(text = 'Проверка завершена.') {
    this.emit('notification', {
      method: 'item/agentMessage/delta',
      params: { threadId: this.threadId, itemId: 'reply', delta: text },
    });
    this.emit('notification', {
      method: 'item/completed',
      params: { threadId: this.threadId, item: { type: 'agentMessage', id: 'reply', text } },
    });
    this.emit('notification', {
      method: 'turn/completed',
      params: { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } },
    });
  }
}
async function eventually(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('Timed out waiting for expected state');
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'plus-test-'));
  const agents: FakeAgent[] = [];
  const instance = await createApp({
    dataDir: join(root, 'data'),
    agentFactory: () => {
      const agent = new FakeAgent();
      agents.push(agent);
      return agent;
    },
  });
  const { app, store } = instance;
  const owner = { authorization: `Bearer ${store.ownerToken}`, 'x-plus-client': '1' };
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = async (name: string) => {
    const path = join(root, name);
    await mkdir(path);
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: owner,
      payload: { name, path },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const guest = async (id: string, name = 'Designer') => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/invitations`,
      headers: owner,
      payload: {},
    });
    const { token } = response.json();
    const joined = await app.inject({
      method: 'POST',
      url: '/api/join',
      headers: { 'x-plus-client': '1', origin: 'http://127.0.0.1:1420' },
      payload: { token, name },
    });
    assert.equal(joined.statusCode, 200, joined.body);
    const cookie = String(joined.headers['set-cookie']).split(';')[0];
    return { headers: { cookie, 'x-plus-client': '1', origin: 'http://127.0.0.1:1420' }, token };
  };
  return { ...instance, root, agents, owner, project, guest };
}

test('invitations are single-use, guests see one project, and native owner API is protected', async (t) => {
  const f = await fixture(t);
  const a = await f.project('A');
  const b = await f.project('B');
  const guest = await f.guest(a.id);
  assert.equal((await f.app.inject('/api/snapshot')).statusCode, 401);
  const snapshot = (await f.app.inject({ url: '/api/snapshot', headers: guest.headers })).json();
  assert.deepEqual(
    snapshot.projects.map((p: any) => p.id),
    [a.id],
  );
  assert.equal(
    (await f.app.inject({ url: `/api/projects/${b.id}/git`, headers: guest.headers })).statusCode,
    404,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: guest.headers,
        payload: { path: f.root },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/join',
        headers: guest.headers,
        payload: { token: guest.token, name: 'Intruder' },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'PATCH',
        url: `/api/projects/${a.id}/mode`,
        headers: guest.headers,
        payload: { mode: 'edit' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/projects/${b.id}/messages`,
        headers: guest.headers,
        payload: { id: randomUUID(), text: 'injected', agent: false },
      })
    ).statusCode,
    404,
  );
});

test('team messages persist and retried delivery does not duplicate a message or trigger an agent', async (t) => {
  const f = await fixture(t);
  const p = await f.project('Chat');
  const guest = await f.guest(p.id);
  const id = randomUUID();
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/projects/${p.id}/messages`,
          headers: guest.headers,
          payload: { id, text: 'Посмотрим макет вместе', agent: false },
        })
      ).statusCode,
      200,
    );
  assert.equal(f.store.messages(p.id).length, 1);
  assert.equal(f.agents.length, 0);
  assert.equal(f.store.messages(p.id)[0].author, 'Designer');
});

test('tasks serialize, stream real protocol events into durable messages, and resume the project thread', async (t) => {
  const f = await fixture(t);
  const p = await f.project('Queue');
  for (let i = 0; i < 2; i++)
    await f.app.inject({
      method: 'POST',
      url: `/api/projects/${p.id}/messages`,
      headers: f.owner,
      payload: { id: randomUUID(), text: `Task ${i}`, agent: true },
    });
  await eventually(() => f.agents[0]?.calls.some((c) => c.method === 'turn/start'));
  assert.equal(f.agents.length, 1);
  assert.deepEqual(
    f.store.tasks(p.id).map((t) => t.status),
    ['running', 'queued'],
  );
  const params = f.agents[0].calls.find((c) => c.method === 'turn/start')!.params;
  assert.deepEqual(params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  f.agents[0].finish();
  await eventually(() => f.agents[1]?.calls.some((c) => c.method === 'turn/start'));
  assert.equal(
    f.agents[1].calls.find((c) => c.method === 'thread/resume')!.params.threadId,
    f.agents[0].threadId,
  );
  f.agents[1].finish('Вторая задача завершена');
  await eventually(() => f.store.tasks(p.id).every((t) => t.status === 'completed'));
  assert.equal(f.store.messages(p.id).filter((m) => m.kind === 'agent').length, 2);
});

test('a guest cannot approve execution or stop another participant task', async (t) => {
  const f = await fixture(t);
  const p = await f.project('Approval');
  const guest = await f.guest(p.id);
  await f.app.inject({
    method: 'POST',
    url: `/api/projects/${p.id}/messages`,
    headers: f.owner,
    payload: { id: randomUUID(), text: 'Inspect', agent: true },
  });
  await eventually(() => f.agents[0]?.calls.some((c) => c.method === 'turn/start'));
  f.agents[0].emit('request', {
    id: 42,
    method: 'item/commandExecution/requestApproval',
    params: { command: 'example-command' },
  });
  const approval = f.scheduler.approvals()[0];
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}`,
        headers: guest.headers,
        payload: { allow: true },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/tasks/${f.store.tasks(p.id)[0].id}/stop`,
        headers: guest.headers,
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/approvals/${approval.id}`,
        headers: f.owner,
        payload: { allow: false },
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(f.agents[0].answers[0], { id: 42, result: { decision: 'decline' } });
  f.agents[0].finish();
  await eventually(() => f.store.tasks(p.id)[0].status === 'completed');
});

test('cancelling a queued task never starts it and cancelling an active task releases its process', async (t) => {
  const f = await fixture(t);
  const p = await f.project('Cancel');
  for (let i = 0; i < 2; i++)
    await f.app.inject({
      method: 'POST',
      url: `/api/projects/${p.id}/messages`,
      headers: f.owner,
      payload: { id: randomUUID(), text: 'Task', agent: true },
    });
  const tasks = f.store.tasks(p.id);
  await f.scheduler.cancel(tasks[1].id);
  await f.scheduler.cancel(tasks[0].id);
  await eventually(() => f.agents[0].closed);
  assert.equal(f.agents.length, 1);
  assert.ok(f.store.tasks(p.id).every((t) => t.status === 'cancelled'));
});

test('malicious origins and missing CSRF headers are rejected', async (t) => {
  const f = await fixture(t);
  const p = await f.project('Origin');
  const guest = await f.guest(p.id);
  assert.equal(
    (
      await f.app.inject({
        url: '/api/snapshot',
        headers: { ...guest.headers, origin: 'https://evil.example' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: `/api/projects/${p.id}/messages`,
        headers: { cookie: guest.headers.cookie, origin: guest.headers.origin },
        payload: { id: randomUUID(), text: 'CSRF', agent: false },
      })
    ).statusCode,
    403,
  );
});

test('attachment IDs enforce project boundaries and actual image signatures', async (t) => {
  const f = await fixture(t);
  const a = await f.project('ImagesA');
  const b = await f.project('ImagesB');
  const guest = await f.guest(b.id);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA2kAAAAASUVORK5CYII=',
    'base64',
  );
  const upload = await f.app.inject({
    method: 'POST',
    url: `/api/projects/${a.id}/attachments`,
    headers: f.owner,
    payload: { name: 'pixel.png', mime: 'image/png', base64: png.toString('base64') },
  });
  assert.equal(upload.statusCode, 200);
  assert.equal(
    (await f.app.inject({ url: `/api/attachments/${upload.json().id}`, headers: guest.headers }))
      .statusCode,
    404,
  );
  const bad = await f.app.inject({
    method: 'POST',
    url: `/api/projects/${a.id}/attachments`,
    headers: f.owner,
    payload: {
      name: 'fake.png',
      mime: 'image/png',
      base64: Buffer.from('<script>alert(1)</script>').toString('base64'),
    },
  });
  assert.equal(bad.statusCode, 400);
});

test('WebSocket needs authentication, filters project events, and revocation closes access', async (t) => {
  const f = await fixture(t);
  const a = await f.project('WsA');
  const b = await f.project('WsB');
  const guest = await f.guest(a.id);
  await f.app.listen({ port: 0, host: '127.0.0.1' });
  const address = f.app.server.address() as { port: number };
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/events`, {
    headers: guest.headers,
  });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const ready = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'authenticate' }));
  await ready;
  const events: any[] = [];
  socket.on('message', (data) => events.push(JSON.parse(String(data))));
  for (const p of [a, b])
    await f.app.inject({
      method: 'POST',
      url: `/api/projects/${p.id}/messages`,
      headers: f.owner,
      payload: { id: randomUUID(), text: 'Event', agent: false },
    });
  await eventually(() => events.length > 0);
  assert.ok(events.every((e) => e.projectId === a.id));
  const member = f.store.members(a.id).find((p) => p.role === 'member')!;
  const closed = once(socket, 'close');
  await f.app.inject({
    method: 'DELETE',
    url: `/api/projects/${a.id}/members/${member.id}`,
    headers: f.owner,
    payload: {},
  });
  await closed;
  assert.equal(
    (await f.app.inject({ url: '/api/snapshot', headers: guest.headers })).statusCode,
    401,
  );
});

test('restart preserves messages but does not automatically replay interrupted or queued work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plus-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = new Store(root);
  const p = initial.createProject('Recovery', root);
  const id = randomUUID();
  initial.addMessage({
    id,
    projectId: p.id,
    author: 'Owner',
    authorId: 'owner',
    kind: 'human',
    text: 'Persist me',
    createdAt: now(),
    taskId: null,
    attachments: [],
  });
  for (const status of ['running', 'queued'] as const)
    initial.saveTask({
      id: randomUUID(),
      projectId: p.id,
      messageId: id,
      status,
      createdAt: now(),
      activity: '',
      error: null,
      model: null,
      mode: 'read',
    });
  initial.close();
  const recovered = await createApp({ dataDir: root });
  assert.equal(recovered.store.messages(p.id)[0].text, 'Persist me');
  assert.deepEqual(
    recovered.store.tasks(p.id).map((t) => t.status),
    ['failed', 'cancelled'],
  );
  await recovered.app.close();
});

test('agent screenshots become durable inline attachments scoped to their project', async (t) => {
  const f = await fixture(t);
  const project = await f.project('Screenshots');
  const other = await f.project('Other');
  const guest = await f.guest(project.id);
  const stranger = await f.guest(other.id);
  const screenshot = join(f.root, 'screen shot.png');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(screenshot, png);
  const id = randomUUID();
  await f.app.inject({
    method: 'POST',
    url: `/api/projects/${project.id}/messages`,
    headers: f.owner,
    payload: { id, text: 'Show screenshot', agent: true },
  });
  await eventually(() => f.agents[0]?.calls.some((c) => c.method === 'turn/start'));
  f.agents[0].finish(`Screen:\n\n![Main screen](<${screenshot}>)`);
  await eventually(() => f.store.tasks(project.id)[0]?.status === 'completed');
  const message = f.store.messages(project.id).find((m) => m.kind === 'agent')!;
  assert.equal(message.attachments.length, 1);
  const attachment = message.attachments[0];
  assert.equal(attachment.inline, true);
  assert.ok(message.text.includes(`/api/attachments/${attachment.id}`));
  assert.ok(!message.text.includes(screenshot));
  assert.equal(importAgentImages(f.store, message), message);
  await rm(screenshot);
  const response = await f.app.inject({
    url: `/api/attachments/${attachment.id}`,
    headers: guest.headers,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, png);
  assert.equal(
    (await f.app.inject({ url: `/api/attachments/${attachment.id}`, headers: stranger.headers }))
      .statusCode,
    404,
  );
  assert.equal((await f.app.inject(`/api/attachments/${attachment.id}`)).statusCode, 401);
});

test('existing agent screenshots recover on startup; human paths, code, remote URLs and invalid files are not imported', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'plus-image-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const screenshot = join(root, 'screen.png');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  await writeFile(screenshot, png);
  await writeFile(join(root, 'invalid.png'), 'not an image');
  const store = new Store(join(root, 'data'));
  const project = store.createProject('Recovery', root);
  const message = {
    id: randomUUID(),
    projectId: project.id,
    author: 'Codex',
    authorId: 'agent',
    kind: 'agent' as const,
    text: `![Screenshot](${screenshot})`,
    createdAt: now(),
    taskId: null,
    attachments: [],
  };
  const human = { ...message, kind: 'human' as const };
  assert.equal(importAgentImages(store, human), human);
  const ignored = {
    ...message,
    text: `\`![Code](${screenshot})\`\n![Remote](https://example.com/screen.png)\n![Invalid](${root}/invalid.png)\n![Missing](${root}/missing.png)`,
  };
  assert.equal(importAgentImages(store, ignored), ignored);
  store.addMessage(message);
  store.close();
  const recovered = await createApp({ dataDir: join(root, 'data') });
  const restored = recovered.store.message(message.id)!;
  assert.equal(restored.attachments.length, 1);
  assert.equal(restored.createdAt, message.createdAt);
  assert.deepEqual(
    await readFile(join(root, 'data', 'attachments', restored.attachments[0].id)),
    png,
  );
  await recovered.app.close();
});

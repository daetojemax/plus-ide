import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppEvent, Attachment, Message, Person, Project, Task } from '../shared/protocol';

export const now = () => new Date().toISOString();
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const decode = <T>(row: unknown): T => JSON.parse((row as { data: string }).data) as T;
export interface Session extends Person {
  projectId: string | null;
}

export class Store {
  readonly db: DatabaseSync;
  readonly ownerToken: string;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    mkdirSync(join(directory, 'attachments'), { recursive: true, mode: 0o700 });
    const key = join(directory, 'owner.key');
    if (!existsSync(key)) writeFileSync(key, token(), { mode: 0o600 });
    chmodSync(key, 0o600);
    this.ownerToken = readFileSync(key, 'utf8').trim();
    this.db = new DatabaseSync(join(directory, 'plus.sqlite'));
    chmodSync(join(directory, 'plus.sqlite'), 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, data TEXT NOT NULL, thread_id TEXT, mode TEXT NOT NULL DEFAULT 'read');
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, project_id TEXT REFERENCES projects(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (digest TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), owner_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS message_project ON messages(project_id);
      CREATE INDEX IF NOT EXISTS task_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS event_project ON events(project_id, seq);
    `);
  }
  owner(): Session {
    return {
      id: 'owner',
      name: this.setting('ownerName') || 'Владелец',
      role: 'owner',
      projectId: null,
    };
  }
  setting(key: string): string {
    return (
      (
        this.db.prepare('SELECT value FROM settings WHERE id=?').get(key) as
          { value: string } | undefined
      )?.value || ''
    );
  }
  setSetting(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, value);
  }
  projects(): Project[] {
    return this.db
      .prepare('SELECT data FROM projects ORDER BY rowid')
      .all()
      .map(decode<Project>);
  }
  project(id: string): Project | undefined {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id);
    return row ? decode<Project>(row) : undefined;
  }
  createProject(name: string, path: string): Project {
    const project: Project = { id: randomUUID(), name, path, createdAt: now() };
    this.db
      .prepare('INSERT INTO projects (id,path,data) VALUES (?,?,?)')
      .run(project.id, path, JSON.stringify(project));
    return project;
  }
  mode(id: string): 'read' | 'edit' {
    return (
      this.db.prepare('SELECT mode FROM projects WHERE id=?').get(id) as { mode: 'read' | 'edit' }
    ).mode;
  }
  setMode(id: string, mode: 'read' | 'edit') {
    this.db.prepare('UPDATE projects SET mode=? WHERE id=?').run(mode, id);
  }
  thread(id: string): string | null {
    return (
      (
        this.db.prepare('SELECT thread_id FROM projects WHERE id=?').get(id) as {
          thread_id: string | null;
        }
      )?.thread_id || null
    );
  }
  setThread(id: string, thread: string) {
    this.db.prepare('UPDATE projects SET thread_id=? WHERE id=?').run(thread, id);
  }
  messages(id: string): Message[] {
    return this.db
      .prepare('SELECT data FROM messages WHERE project_id=? ORDER BY rowid')
      .all(id)
      .map(decode<Message>);
  }
  message(id: string): Message | undefined {
    const row = this.db.prepare('SELECT data FROM messages WHERE id=?').get(id);
    return row ? decode<Message>(row) : undefined;
  }
  addMessage(message: Message) {
    this.db
      .prepare('INSERT OR REPLACE INTO messages VALUES (?,?,?)')
      .run(message.id, message.projectId, JSON.stringify(message));
  }
  tasks(projectId?: string): Task[] {
    const rows = projectId
      ? this.db.prepare('SELECT data FROM tasks WHERE project_id=? ORDER BY rowid').all(projectId)
      : this.db.prepare('SELECT data FROM tasks ORDER BY rowid').all();
    return rows.map(decode<Task>);
  }
  task(id: string): Task | undefined {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
    return row ? decode<Task>(row) : undefined;
  }
  saveTask(task: Task) {
    this.db
      .prepare('INSERT OR REPLACE INTO tasks VALUES (?,?,?)')
      .run(task.id, task.projectId, JSON.stringify(task));
  }
  recover() {
    for (const task of this.tasks())
      if (['running', 'waiting', 'queued'].includes(task.status)) {
        this.saveTask({
          ...task,
          status: task.status === 'queued' ? 'cancelled' : 'failed',
          activity: '',
          error: 'Сервер был перезапущен. Отправьте задачу повторно, если её нужно продолжить.',
        });
      }
  }
  invite(projectId: string): string {
    const raw = token();
    this.db
      .prepare('INSERT INTO invites VALUES (?,?,?)')
      .run(hash(raw), projectId, Date.now() + 24 * 60 * 60 * 1000);
    return raw;
  }
  inviteProject(raw: string): Project | undefined {
    const row = this.db
      .prepare('SELECT project_id FROM invites WHERE digest=? AND expires>?')
      .get(hash(raw), Date.now()) as { project_id: string } | undefined;
    return row ? this.project(row.project_id) : undefined;
  }
  join(raw: string, name: string): { raw: string; person: Session } | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const project = this.inviteProject(raw);
      if (!project) {
        this.db.exec('ROLLBACK');
        return;
      }
      const session = token();
      const person: Session = { id: randomUUID(), name, role: 'member', projectId: project.id };
      this.db.prepare('DELETE FROM invites WHERE digest=?').run(hash(raw));
      this.db
        .prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)')
        .run(
          hash(session),
          person.id,
          name,
          'member',
          project.id,
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        );
      this.db.exec('COMMIT');
      return { raw: session, person };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  session(raw: string): Session | undefined {
    const row = this.db
      .prepare('SELECT id,name,role,project_id FROM sessions WHERE digest=? AND expires>?')
      .get(hash(raw), Date.now()) as
      { id: string; name: string; role: 'member'; project_id: string } | undefined;
    return row
      ? { id: row.id, name: row.name, role: row.role, projectId: row.project_id }
      : undefined;
  }
  members(projectId: string): Person[] {
    return [
      this.owner(),
      ...(this.db
        .prepare('SELECT id,name,role FROM sessions WHERE project_id=? AND expires>?')
        .all(projectId, Date.now()) as unknown as Person[]),
    ];
  }
  revoke(projectId: string, id: string) {
    this.db.prepare('DELETE FROM sessions WHERE project_id=? AND id=?').run(projectId, id);
  }
  revokeInvites(projectId: string) {
    this.db.prepare('DELETE FROM invites WHERE project_id=?').run(projectId);
  }
  attachment(id: string): (Attachment & { projectId: string; ownerId: string }) | undefined {
    const row = this.db
      .prepare('SELECT data,project_id,owner_id FROM attachments WHERE id=?')
      .get(id) as { data: string; project_id: string; owner_id: string } | undefined;
    return row
      ? { ...JSON.parse(row.data), projectId: row.project_id, ownerId: row.owner_id }
      : undefined;
  }
  addAttachment(projectId: string, ownerId: string, data: Attachment) {
    this.db
      .prepare('INSERT INTO attachments VALUES (?,?,?,?)')
      .run(data.id, projectId, ownerId, JSON.stringify(data));
  }
  event(projectId: string, type: AppEvent['type'], payload?: AppEvent['payload']): AppEvent {
    const event = { projectId, type, ...(payload ? { payload } : {}) };
    const row = this.db
      .prepare('INSERT INTO events(project_id,data) VALUES (?,?)')
      .run(projectId, JSON.stringify(event));
    return { ...event, seq: Number(row.lastInsertRowid) };
  }
  cursor(): number {
    return (
      this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as { seq: number }
    ).seq;
  }
  close() {
    this.db.close();
  }
}

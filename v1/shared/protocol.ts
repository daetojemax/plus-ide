export type Role = 'owner' | 'member';
export interface Person {
  id: string;
  name: string;
  role: Role;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}
export interface Attachment {
  inline?: boolean;
  id: string;
  name: string;
  mime: string;
  size: number;
}
export interface Message {
  id: string;
  projectId: string;
  author: string;
  authorId: string;
  kind: 'human' | 'agent' | 'system';
  text: string;
  createdAt: string;
  taskId: string | null;
  attachments: Attachment[];
}
export type TaskStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export interface Task {
  id: string;
  projectId: string;
  messageId: string;
  status: TaskStatus;
  createdAt: string;
  activity: string;
  error: string | null;
  model: string | null;
  mode: 'read' | 'edit';
}
export interface Approval {
  id: string;
  projectId: string;
  taskId: string;
  title: string;
  detail: string;
}
export interface ModelOption {
  id: string;
  name: string;
  isDefault: boolean;
}
export interface GitFile {
  path: string;
  status: string;
}
export interface GitState {
  available: boolean;
  branch: string;
  files: GitFile[];
  diff: string;
  truncated: boolean;
}
export interface Snapshot {
  me: Person;
  projects: Project[];
  messages: Message[];
  tasks: Task[];
  members: Record<string, Person[]>;
  approvals: Approval[];
  settings: { publicUrl: string; ownerName: string };
  cursor: number;
}
export interface AppEvent {
  seq: number;
  projectId: string;
  type: 'changed' | 'agent.delta' | 'activity';
  payload?: { taskId: string; itemId?: string; text: string };
}

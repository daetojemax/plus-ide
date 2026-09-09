import type {
  AppEvent,
  Attachment,
  GitState,
  ModelOption,
  Project,
  Snapshot,
} from '../shared/protocol';

export type ClientSnapshot = Snapshot & { modes: Record<string, 'read' | 'edit'> };
export const isDesktop = '__TAURI_INTERNALS__' in window;
let base = '';
let ownerToken = sessionStorage.getItem('plus-owner') || '';
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function bootstrap() {
  if (isDesktop) {
    const { invoke } = await import('@tauri-apps/api/core');
    const connection = await invoke<{ url: string; token: string }>('get_connection');
    base = connection.url;
    ownerToken = connection.token;
  }
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (params.has('owner')) {
    setOwnerToken(params.get('owner')!);
    history.replaceState(null, '', location.pathname);
  }
}
export function setOwnerToken(value: string) {
  ownerToken = value;
  sessionStorage.setItem('plus-owner', value);
}
export function localUrl() {
  return base || location.origin;
}
function headers(json = false): HeadersInit {
  return {
    ...(json ? { 'Content-Type': 'application/json', 'X-Plus-Client': '1' } : {}),
    ...(ownerToken ? { Authorization: `Bearer ${ownerToken}` } : {}),
  };
}
export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: headers(method !== 'GET'),
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, data.error || `Ошибка запроса (${response.status})`);
  }
  return response.json() as Promise<T>;
}
export const api = {
  snapshot: () => request<ClientSnapshot>('/snapshot'),
  createProject: (path: string, name: string) =>
    request<Project>('/projects', 'POST', { path, name: name || undefined }),
  send: (
    projectId: string,
    text: string,
    agent: boolean,
    attachments: string[],
    model: string | null,
    id = crypto.randomUUID(),
  ) => request(`/projects/${projectId}/messages`, 'POST', { id, text, agent, attachments, model }),
  stop: (id: string) => request(`/tasks/${id}/stop`, 'POST', {}),
  approve: (id: string, allow: boolean) => request(`/approvals/${id}`, 'POST', { allow }),
  git: (id: string) => request<GitState>(`/projects/${id}/git`),
  setMode: (id: string, mode: 'read' | 'edit') =>
    request(`/projects/${id}/mode`, 'PATCH', { mode }),
  models: () => request<ModelOption[]>('/models'),
  invite: (id: string) => request<{ token: string }>(`/projects/${id}/invitations`, 'POST', {}),
  revokeInvites: (id: string) => request(`/projects/${id}/invitations`, 'DELETE', {}),
  revokeMember: (id: string, member: string) =>
    request(`/projects/${id}/members/${member}`, 'DELETE', {}),
  settings: (ownerName: string, publicUrl: string) =>
    request('/settings', 'PATCH', { ownerName, publicUrl }),
  invitation: (token: string) =>
    request<{ name: string; owner: string }>(`/invitations/${encodeURIComponent(token)}`),
  join: (token: string, name: string) => request('/join', 'POST', { token, name }),
  upload: async (projectId: string, file: File): Promise<Attachment> => {
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size > 6 * 1024 * 1024
    )
      throw new Error('Выберите PNG, JPEG или WebP до 6 МБ.');
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    return request(`/projects/${projectId}/attachments`, 'POST', {
      name: file.name,
      mime: file.type,
      base64,
    });
  },
  image: async (id: string) => {
    const response = await fetch(`${base}/api/attachments/${id}`, {
      headers: headers(),
      credentials: 'include',
    });
    if (!response.ok) throw new Error('Изображение недоступно');
    return URL.createObjectURL(await response.blob());
  },
};
export function connectEvents(
  onEvent: (event: AppEvent) => void,
  onStatus: (state: 'online' | 'offline' | 'connecting') => void,
  onReady: () => void,
) {
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout>;
  let delay = 1000;
  function connect() {
    if (stopped) return;
    onStatus('connecting');
    const url = new URL('/api/events', base || location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(url);
    socket.onopen = () =>
      socket?.send(
        JSON.stringify({ type: 'authenticate', ...(ownerToken ? { token: ownerToken } : {}) }),
      );
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.type === 'ready') {
          delay = 1000;
          onStatus('online');
          onReady();
        } else onEvent(event);
      } catch {}
    };
    socket.onerror = () => socket?.close();
    socket.onclose = (event) => {
      onStatus('offline');
      if (stopped) return;
      if (event.code === 4001) {
        onReady();
        return;
      }
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15_000);
    };
  }
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket?.close();
  };
}

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  ArrowUp,
  AtSign,
  Check,
  ChevronRight,
  FolderSearch,
  GitBranch,
  LoaderCircle,
  Paperclip,
  Plus,
  Shield,
  Square,
  X,
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  Approval,
  Attachment,
  Message,
  ModelOption,
  Person,
  Project,
  Task,
} from '../../shared/protocol';
import { api } from '../api';
import { Avatar, ErrorNotice } from './Primitives';

function StoredImage({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let blob = '';
    void api
      .image(attachment.id)
      .then((result) => {
        blob = result;
        if (disposed) URL.revokeObjectURL(result);
        else setUrl(result);
      })
      .catch(() => setError(true));
    return () => {
      disposed = true;
      if (blob) URL.revokeObjectURL(blob);
    };
  }, [attachment.id]);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="message-image">
      <img src={url} alt={attachment.name} />
    </a>
  ) : (
    <span className="muted">{error ? 'Изображение недоступно' : 'Загружаю изображение…'}</span>
  );
}
const noAttachments: Attachment[] = [];
const MarkdownAttachments = createContext<Attachment[]>(noAttachments);
// Component types must stay stable across composer edits and incoming snapshots.
// Inline renderer functions remount StoredImage and reload its blob on every render.
const markdownComponents: Components = {
  a: ({ node: _, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  img: function MarkdownImage({ src, alt }) {
    const attachments = useContext(MarkdownAttachments);
    const attachment = attachments.find((a) => src === `/api/attachments/${a.id}`);
    return attachment ? (
      <StoredImage attachment={attachment} />
    ) : (
      <span className="muted">{alt || 'Изображение из сообщения'}</span>
    );
  },
};
const markdownPlugins = [remarkGfm];
const Markdown = memo(function Markdown({
  text,
  attachments = noAttachments,
}: {
  text: string;
  attachments?: Attachment[];
}) {
  return (
    <MarkdownAttachments.Provider value={attachments}>
      <div className="markdown">
        <ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents}>
          {text}
        </ReactMarkdown>
      </div>
    </MarkdownAttachments.Provider>
  );
});
const statusNames: Record<Task['status'], string> = {
  queued: 'В очереди',
  running: 'Выполняется',
  waiting: 'Нужно решение',
  completed: 'Готово',
  failed: 'Ошибка',
  cancelled: 'Остановлено',
};

export function Conversation({
  project,
  me,
  messages,
  tasks,
  streams,
  approvals,
  mode,
  onCreate,
  onRefresh,
}: {
  project?: Project;
  me: Person;
  messages: Message[];
  tasks: Task[];
  streams: Record<string, string>;
  approvals: Approval[];
  mode: 'read' | 'edit';
  onCreate: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [agent, setAgent] = useState(true);
  const [model, setModel] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const projectRef = useRef(project?.id);
  projectRef.current = project?.id;
  const active = tasks.filter((t) => ['running', 'waiting', 'queued'].includes(t.status));
  useEffect(() => {
    setText(project ? sessionStorage.getItem(`draft:${project.id}`) || '' : '');
    setAttachments([]);
    setError('');
    stick.current = true;
  }, [project?.id]);
  useEffect(() => {
    if (stick.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, streams, tasks]);
  const editText = (value: string) => {
    setText(value);
    if (project) sessionStorage.setItem(`draft:${project.id}`, value);
  };
  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!project || sending || uploading || (!text.trim() && !attachments.length)) return;
    const id = project.id;
    setSending(true);
    setError('');
    try {
      await api.send(
        id,
        text,
        agent,
        attachments.map((a) => a.id),
        model,
      );
      sessionStorage.removeItem(`draft:${id}`);
      if (projectRef.current === id) {
        setText('');
        setAttachments([]);
        stick.current = true;
      }
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      input.current?.focus();
    }
  }
  async function upload(files: FileList | null) {
    if (!project || !files) return;
    const id = project.id;
    if (files.length + attachments.length > 4) {
      setError('Можно прикрепить до четырёх изображений.');
      return;
    }
    setUploading(true);
    setError('');
    try {
      const uploaded = await Promise.all(Array.from(files).map((file) => api.upload(id, file)));
      if (projectRef.current === id) setAttachments((current) => [...current, ...uploaded]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function perform(action: () => Promise<unknown>) {
    try {
      setError('');
      await action();
      await onRefresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const suggest = (value: string) => {
    editText(value);
    setAgent(true);
    input.current?.focus();
  };
  const visibleStreams = Object.entries(streams).filter(
    ([key]) => tasks.some((t) => key.startsWith(`${t.id}:`)) && !messages.some((m) => m.id === key),
  );
  return (
    <section className="conversation" aria-label="Общий чат">
      <div
        ref={scroll}
        className="message-scroll"
        onLoadCapture={() => {
          if (stick.current && scroll.current)
            scroll.current.scrollTop = scroll.current.scrollHeight;
        }}
        onScroll={() => {
          const el = scroll.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
      >
        {!messages.length ? (
          <div className="empty-chat">
            <div className="empty-symbol">
              <Plus size={30} />
            </div>
            <h1>{project ? 'Над чем поработаем?' : 'Ваш следующий проект — здесь'}</h1>
            <p>
              {project
                ? 'Обсуждайте проект вместе. Поручайте задачи агенту.'
                : 'Выберите папку и начните общий разговор с агентом.'}
            </p>
            {project ? (
              <div className="suggestions">
                <button
                  onClick={() =>
                    suggest(
                      'Изучи структуру проекта и кратко расскажи, как он устроен. Не изменяй файлы.',
                    )
                  }
                >
                  <FolderSearch size={23} />
                  <span>
                    <strong>Изучить проект</strong>
                    <small>
                      Попросите агента разобраться
                      <br />в кодовой базе
                    </small>
                  </span>
                  <ChevronRight size={16} />
                </button>
                <button
                  onClick={() =>
                    suggest(
                      'Проверь текущие изменения в Git. Найди возможные ошибки и предложи улучшения. Не изменяй файлы.',
                    )
                  }
                >
                  <GitBranch size={23} />
                  <span>
                    <strong>Проверить изменения</strong>
                    <small>
                      Попросите агента проанализировать
                      <br />
                      дифф и предложить улучшения
                    </small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              </div>
            ) : me.role === 'owner' ? (
              <button className="primary-button" onClick={onCreate}>
                <Plus size={17} />
                Добавить проект
              </button>
            ) : null}
          </div>
        ) : (
          <div className="messages">
            <div className="conversation-start">
              <span />
              Начало общего разговора
              <span />
            </div>
            {messages.map((message) => (
              <article key={message.id} className={`message ${message.kind}`}>
                <Avatar name={message.author} agent={message.kind === 'agent'} />
                <div className="message-content">
                  <div className="message-meta">
                    <strong>{message.authorId === me.id ? 'Вы' : message.author}</strong>
                    {message.kind === 'agent' ? <span className="agent-label">Агент</span> : null}
                    <time>
                      {new Date(message.createdAt).toLocaleTimeString('ru-RU', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                  <Markdown text={message.text} attachments={message.attachments} />
                  {message.attachments.length ? (
                    <div className="message-attachments">
                      {message.attachments
                        .filter((a) => !a.inline)
                        .map((a) => (
                          <StoredImage key={a.id} attachment={a} />
                        ))}
                    </div>
                  ) : null}
                  {message.kind === 'human' && message.taskId
                    ? (() => {
                        const task = tasks.find((t) => t.id === message.taskId);
                        return task ? (
                          <div className={`task-status ${task.status}`}>
                            {task.status === 'completed' ? (
                              <Check size={13} />
                            ) : ['running', 'waiting'].includes(task.status) ? (
                              <LoaderCircle size={13} className="spin" />
                            ) : (
                              <span className="status-dot" />
                            )}
                            {statusNames[task.status]}
                            {task.error ? <span className="task-error">{task.error}</span> : null}
                            {active.some((t) => t.id === task.id) &&
                            (me.role === 'owner' || message.authorId === me.id) ? (
                              <button
                                onClick={() => void perform(() => api.stop(task.id))}
                                title="Остановить задачу"
                              >
                                <Square size={11} />
                                Остановить
                              </button>
                            ) : null}
                          </div>
                        ) : null;
                      })()
                    : null}
                </div>
              </article>
            ))}
            {visibleStreams.map(([id, value]) => (
              <article key={id} className="message agent streaming">
                <Avatar name="Codex" agent />
                <div className="message-content">
                  <div className="message-meta">
                    <strong>Codex</strong>
                    <span className="agent-label">Агент</span>
                    <LoaderCircle size={12} className="spin" />
                  </div>
                  <Markdown text={value} />
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      <div className="composer-area">
        {approvals.map((approval) => (
          <div className="approval" key={approval.id}>
            <Shield size={19} />
            <div>
              <strong>{approval.title}</strong>
              <pre>{approval.detail}</pre>
              {me.role === 'owner' ? (
                <div className="approval-actions">
                  <button
                    className="secondary-button"
                    onClick={() => void perform(() => api.approve(approval.id, false))}
                  >
                    Отклонить
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => void perform(() => api.approve(approval.id, true))}
                  >
                    Разрешить один раз
                  </button>
                </div>
              ) : (
                <small>Ожидаем решение владельца проекта</small>
              )}
            </div>
          </div>
        ))}
        {active.length ? (
          <div className="activity-bar">
            <LoaderCircle size={13} className="spin" />
            <span>{active.find((t) => t.status !== 'queued')?.activity || 'Задача в очереди'}</span>
            {active.length > 1 ? (
              <small>В очереди: {active.filter((t) => t.status === 'queued').length}</small>
            ) : null}
          </div>
        ) : null}
        <ErrorNotice text={error} />
        <form
          className={`composer ${!project ? 'disabled' : ''}`}
          onSubmit={send}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void upload(e.dataTransfer.files);
          }}
        >
          {attachments.length ? (
            <div className="attachment-chips">
              {attachments.map((a) => (
                <span key={a.id}>
                  <Paperclip size={12} />
                  {a.name}
                  <button
                    type="button"
                    aria-label={`Убрать ${a.name}`}
                    onClick={() =>
                      setAttachments((items) => items.filter((item) => item.id !== a.id))
                    }
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={input}
            value={text}
            onChange={(e) => editText(e.target.value)}
            placeholder="Сообщение команде или задача для агента…"
            aria-label="Сообщение"
            disabled={!project}
            rows={2}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                void upload(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-toolbar">
            <button
              type="button"
              className={`composer-chip ${agent ? 'active' : ''}`}
              disabled={!project}
              onClick={() => setAgent(!agent)}
              aria-pressed={agent}
            >
              <AtSign size={14} />
              {agent ? 'Агент' : 'Команда'}
            </button>
            <button
              type="button"
              className="icon-button"
              disabled={!project || uploading}
              onClick={() => fileInput.current?.click()}
              aria-label="Прикрепить изображение"
            >
              {uploading ? <LoaderCircle size={16} className="spin" /> : <Paperclip size={17} />}
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => void upload(e.target.files)}
            />
            <select
              aria-label="Модель агента"
              className="model-select"
              value={model || ''}
              disabled={!project || !agent}
              onFocus={() => {
                if (!models.length)
                  void api
                    .models()
                    .then(setModels)
                    .catch((e) => setError(e.message));
              }}
              onChange={(e) => setModel(e.target.value || null)}
            >
              <option value="">По умолчанию</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <div className="composer-spacer" />
            {project && me.role === 'owner' ? (
              <select
                className="access-select"
                aria-label="Доступ агента"
                value={mode}
                onChange={(e) =>
                  void perform(() => api.setMode(project.id, e.target.value as 'read' | 'edit'))
                }
              >
                <option value="read">Только чтение</option>
                <option value="edit">Изменение файлов</option>
              </select>
            ) : null}
            <button
              type="submit"
              className="send-button"
              disabled={!project || sending || uploading || (!text.trim() && !attachments.length)}
              aria-label={agent ? 'Отправить задачу агенту' : 'Отправить сообщение'}
            >
              {sending ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={19} />}
            </button>
          </div>
        </form>
        <div className="composer-hint">
          {agent && active.length
            ? 'Следующая задача встанет в очередь'
            : 'Enter — отправить · Shift Enter — новая строка'}
        </div>
      </div>
    </section>
  );
}

import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  FileCode2,
  Folder,
  GitBranch,
  Laptop,
  LockKeyhole,
  RefreshCw,
  UserMinus,
  X,
} from 'lucide-react';
import type { GitState, Person, Project } from '../../shared/protocol';
import { api } from '../api';
import { Avatar, ErrorNotice } from './Primitives';

export function Inspector({
  project,
  members,
  me,
  revision,
  onRefresh,
  onBranch,
  onClose,
}: {
  project?: Project;
  members: Person[];
  me: Person;
  revision: number;
  onRefresh: () => Promise<void>;
  onBranch: (branch: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'project' | 'changes'>('project');
  const [git, setGit] = useState<GitState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!project) {
      setGit(null);
      onBranch('');
      return;
    }
    setLoading(true);
    void api
      .git(project.id)
      .then((result) => {
        if (!cancelled) {
          setGit(result);
          onBranch(result.branch);
          setError('');
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id, revision, onBranch]);
  const refresh = async () => {
    if (!project) return;
    setLoading(true);
    try {
      const result = await api.git(project.id);
      setGit(result);
      onBranch(result.branch);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <aside className="inspector">
      <div className="inspector-tabs">
        <button className={tab === 'project' ? 'active' : ''} onClick={() => setTab('project')}>
          <Folder size={16} />
          Проект
        </button>
        <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>
          <GitBranch size={16} />
          Изменения{git?.files.length ? <span>{git.files.length}</span> : null}
        </button>
        <button className="icon-button mobile-only" onClick={onClose} aria-label="Скрыть сведения">
          <X size={16} />
        </button>
      </div>
      <div className="inspector-body">
        <ErrorNotice text={error} />
        {tab === 'project' ? (
          <>
            <section className="inspector-section">
              <p className="field-caption">Путь к проекту</p>
              <button
                className="path-box"
                disabled={!project}
                title={project?.path}
                onClick={() => {
                  if (project)
                    void navigator.clipboard
                      .writeText(project.path)
                      .then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      })
                      .catch(() => setError('Не удалось скопировать путь.'));
                }}
              >
                <Folder size={16} />
                <span>{project?.path || 'Проект не выбран'}</span>
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </button>
            </section>
            <section className="inspector-section">
              <h3>УЧАСТНИКИ</h3>
              {members.map((person) => (
                <div className="member-row" key={person.id}>
                  <Avatar name={person.id === me.id ? 'Вы' : person.name} />
                  <span>
                    <strong>{person.id === me.id ? 'Вы' : person.name}</strong>
                    <small>{person.role === 'owner' ? 'Владелец' : 'Участник'}</small>
                  </span>
                  {person.role === 'member' && me.role === 'owner' && project ? (
                    <button
                      className="icon-button revoke-member"
                      title="Отозвать доступ"
                      aria-label={`Отозвать доступ: ${person.name}`}
                      onClick={() =>
                        void api
                          .revokeMember(project.id, person.id)
                          .then(onRefresh)
                          .catch((e) => setError(e.message))
                      }
                    >
                      <UserMinus size={14} />
                    </button>
                  ) : null}
                </div>
              ))}
              <div className="member-row">
                <Avatar name="Codex" agent />
                <span>
                  <strong>Codex</strong>
                  <small>Агент</small>
                </span>
              </div>
            </section>
            <section className="inspector-section environment">
              <h3>РАБОЧАЯ СРЕДА</h3>
              <div>
                <span className="environment-icon">
                  <Laptop size={18} />
                </span>
                <span>
                  <strong>Исполнение</strong>
                  <small>Этот Mac</small>
                </span>
              </div>
              <div>
                <span className="environment-icon">
                  <LockKeyhole size={18} />
                </span>
                <span>
                  <strong>Доступ</strong>
                  <small>По приглашению</small>
                </span>
              </div>
            </section>
          </>
        ) : (
          <section className="changes">
            <div className="changes-heading">
              <span>{git?.available ? git.branch : 'Git'}</span>
              <button
                className="icon-button"
                onClick={() => void refresh()}
                disabled={loading || !project}
                aria-label="Обновить изменения"
              >
                <RefreshCw size={15} className={loading ? 'spin' : ''} />
              </button>
            </div>
            {!project ? (
              <p className="muted">Выберите проект</p>
            ) : git && !git.available ? (
              <div className="inspector-empty">
                <GitBranch size={26} />
                <p>
                  В этой папке пока нет
                  <br />
                  репозитория Git
                </p>
              </div>
            ) : !git?.files.length ? (
              <div className="inspector-empty">
                <Check size={26} />
                <p>Рабочая копия чистая</p>
                <small>Изменения агента появятся здесь</small>
              </div>
            ) : (
              <>
                <h3>ИЗМЕНЁННЫЕ ФАЙЛЫ · {git.files.length}</h3>
                {git.files.map((file) => (
                  <div className="git-file" key={file.path} title={file.path}>
                    <FileCode2 size={15} />
                    <span>{file.path}</span>
                    <small>{file.status}</small>
                  </div>
                ))}
                {git.diff ? (
                  <pre className="diff">
                    {git.diff.split('\n').map((line, i) => (
                      <div
                        key={i}
                        className={
                          line.startsWith('+')
                            ? 'addition'
                            : line.startsWith('-')
                              ? 'deletion'
                              : line.startsWith('@@')
                                ? 'hunk'
                                : ''
                        }
                      >
                        {line || ' '}
                      </div>
                    ))}
                  </pre>
                ) : (
                  <p className="muted">Новые файлы ещё не отслеживаются Git.</p>
                )}
                {git.truncated ? <p className="muted">Показаны первые 150 КБ изменений.</p> : null}
              </>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}

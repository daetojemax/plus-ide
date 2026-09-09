import { useState } from 'react';
import { Plus, Folder, Search, Settings, Circle, PanelLeftClose } from 'lucide-react';
import type { Project, Task } from '../../shared/protocol';
import { Logo } from './Primitives';

export function Sidebar({
  projects,
  tasks,
  selected,
  owner,
  connection,
  onSelect,
  onCreate,
  onSettings,
  onClose,
}: {
  projects: Project[];
  tasks: Task[];
  selected: string;
  owner: boolean;
  connection: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  return (
    <aside className="sidebar">
      <div className="window-drag" data-tauri-drag-region>
        <span className="web-traffic" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <button className="icon-button mobile-only" onClick={onClose} aria-label="Скрыть проекты">
          <PanelLeftClose size={17} />
        </button>
      </div>
      <Logo />
      {owner ? (
        <button className="new-project" onClick={onCreate}>
          <Plus size={18} />
          Новый проект<span>⌘ N</span>
        </button>
      ) : (
        <div className="guest-label">Общее пространство</div>
      )}
      <div className="sidebar-section">
        <span>ПРОЕКТЫ</span>
        {projects.length > 3 ? <Search size={13} /> : null}
      </div>
      {projects.length > 3 ? (
        <input
          className="project-search"
          placeholder="Найти проект…"
          aria-label="Найти проект"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      ) : null}
      <nav aria-label="Проекты">
        {projects
          .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
          .map((project) => {
            const active = tasks.some(
              (t) => t.projectId === project.id && ['running', 'waiting'].includes(t.status),
            );
            return (
              <button
                key={project.id}
                className={`project-row ${selected === project.id ? 'selected' : ''}`}
                onClick={() => onSelect(project.id)}
              >
                <Folder size={17} />
                <span>
                  <strong>{project.name}</strong>
                  <small>{active ? 'Агент работает…' : 'Локальный проект'}</small>
                </span>
                {active ? <span className="live-dot pulse" /> : null}
              </button>
            );
          })}
        {!projects.length ? <p className="sidebar-empty">Здесь появятся ваши проекты</p> : null}
      </nav>
      <footer>
        <span className="server-indicator">
          <Circle
            size={8}
            fill="currentColor"
            className={connection === 'online' ? 'green' : 'muted'}
          />
          {connection === 'online'
            ? 'Этот Mac'
            : connection === 'connecting'
              ? 'Подключение…'
              : 'Нет соединения'}
        </span>
        {owner ? (
          <button className="icon-button" onClick={onSettings} aria-label="Настройки">
            <Settings size={17} />
          </button>
        ) : null}
      </footer>
    </aside>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { GitBranch, LoaderCircle, PanelLeft, PanelRight, UserPlus } from 'lucide-react';
import { useWorkspace } from './useWorkspace';
import { isDesktop } from './api';
import { Sidebar } from './components/Sidebar';
import { Conversation } from './components/Conversation';
import { Inspector } from './components/Inspector';
import { EntryScreen, InviteDialog, ProjectDialog, SettingsDialog } from './components/Dialogs';
import { Avatar, ErrorNotice, Logo } from './components/Primitives';

export default function App() {
  const state = useWorkspace();
  const { snapshot, selected, select, refresh } = state;
  const [dialog, setDialog] = useState<'project' | 'invite' | 'settings' | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [inspector, setInspector] = useState(false);
  const [branch, setBranch] = useState('');
  const onBranch = useCallback((value: string) => setBranch(value), []);
  useEffect(() => {
    if (isDesktop) document.documentElement.classList.add('desktop');
  }, []);
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'n' &&
        snapshot?.me.role === 'owner'
      ) {
        e.preventDefault();
        setDialog('project');
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [snapshot?.me.role]);
  if (!state.loaded)
    return (
      <div className="loading-screen">
        <Logo />
        <LoaderCircle className="spin" size={22} />
        <span>Подключаю локальное пространство…</span>
      </div>
    );
  if (!snapshot || new URLSearchParams(location.hash.slice(1)).has('invite'))
    return <EntryScreen error={state.error} onLogin={refresh} />;
  const project = snapshot.projects.find((p) => p.id === selected);
  const members = project ? snapshot.members[project.id] || [] : [];
  const tasks = snapshot.tasks.filter((t) => t.projectId === selected);
  const messages = snapshot.messages.filter((m) => m.projectId === selected);
  const approvals = snapshot.approvals.filter((a) => a.projectId === selected);
  const owner = snapshot.me.role === 'owner';
  const gitRevision = tasks.filter((t) =>
    ['completed', 'failed', 'cancelled'].includes(t.status),
  ).length;
  return (
    <div
      className={`app-shell ${sidebar ? 'show-sidebar' : ''} ${inspector ? 'show-inspector' : ''}`}
    >
      {sidebar || inspector ? (
        <button
          className="panel-backdrop"
          aria-label="Закрыть панель"
          onClick={() => {
            setSidebar(false);
            setInspector(false);
          }}
        />
      ) : null}
      <Sidebar
        projects={snapshot.projects}
        tasks={snapshot.tasks}
        selected={selected}
        owner={owner}
        connection={state.connection}
        onSelect={(id) => {
          select(id);
          setSidebar(false);
        }}
        onCreate={() => setDialog('project')}
        onSettings={() => setDialog('settings')}
        onClose={() => setSidebar(false)}
      />
      <main className="main-panel">
        <header className="main-toolbar" data-tauri-drag-region>
          <button
            className="icon-button sidebar-toggle"
            onClick={() => setSidebar(!sidebar)}
            aria-label="Показать проекты"
          >
            <PanelLeft size={18} />
          </button>
          <strong>{project?.name || 'Plus'}</strong>
          {branch ? (
            <span className="branch-label">
              <GitBranch size={14} />
              {branch}
            </span>
          ) : null}
          <div className="toolbar-spacer" />
          {owner && project ? (
            <button className="invite-button" onClick={() => setDialog('invite')}>
              <UserPlus size={16} />
              <span>Пригласить</span>
            </button>
          ) : null}
          <div className="toolbar-members">
            {members.slice(0, 3).map((member) => (
              <Avatar
                key={member.id}
                small
                name={member.id === snapshot.me.id ? 'Вы' : member.name}
              />
            ))}
            <Avatar small agent name="Codex" />
          </div>
          <button
            className="icon-button inspector-toggle"
            onClick={() => setInspector(!inspector)}
            aria-label="Показать сведения о проекте"
          >
            <PanelRight size={18} />
          </button>
        </header>
        <ErrorNotice text={state.error} />
        <Conversation
          project={project}
          me={snapshot.me}
          messages={messages}
          tasks={tasks}
          streams={state.streams}
          approvals={approvals}
          mode={snapshot.modes[selected] || 'read'}
          onCreate={() => setDialog('project')}
          onRefresh={refresh}
        />
      </main>
      <Inspector
        project={project}
        members={members}
        me={snapshot.me}
        revision={gitRevision}
        onRefresh={refresh}
        onBranch={onBranch}
        onClose={() => setInspector(false)}
      />
      {dialog === 'project' ? (
        <ProjectDialog
          onClose={() => setDialog(null)}
          onCreated={(p) => {
            setDialog(null);
            void refresh().then(() => select(p.id));
          }}
        />
      ) : null}
      {dialog === 'invite' && project ? (
        <InviteDialog
          project={project}
          publicUrl={snapshot.settings.publicUrl}
          onClose={() => setDialog(null)}
          onSettings={() => setDialog('settings')}
        />
      ) : null}
      {dialog === 'settings' ? (
        <SettingsDialog
          ownerName={snapshot.settings.ownerName}
          publicUrl={snapshot.settings.publicUrl}
          onClose={() => setDialog(null)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}

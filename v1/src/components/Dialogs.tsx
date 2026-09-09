import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, FolderOpen, Link, LoaderCircle, ShieldCheck } from 'lucide-react';
import { api, isDesktop, localUrl, setOwnerToken } from '../api';
import type { Project } from '../../shared/protocol';
import { ErrorNotice, Logo, Modal } from './Primitives';

export function ProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function choose() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const result = await open({
        directory: true,
        multiple: false,
        title: 'Выберите папку проекта',
      });
      if (typeof result === 'string') {
        setPath(result);
        if (!name) setName(result.split('/').at(-1) || '');
      }
    } catch (e) {
      setError(String(e));
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onCreated(await api.createProject(path, name));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Новый проект" onClose={onClose}>
      <p className="dialog-description">
        Один проект — один общий чат. Файлы остаются на вашем Mac.
      </p>
      <form onSubmit={submit}>
        <label>
          Папка проекта
          <div className="input-action">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/you/Projects/MyApp"
              required
              autoFocus={!isDesktop}
            />
            {isDesktop ? (
              <button type="button" className="secondary-button" onClick={() => void choose()}>
                <FolderOpen size={17} />
                Выбрать
              </button>
            ) : null}
          </div>
        </label>
        <label>
          Название
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Название папки"
            maxLength={80}
          />
        </label>
        <ErrorNotice text={error} />
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary-button" disabled={busy || !path}>
            {busy ? <LoaderCircle size={16} className="spin" /> : null}Создать чат
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function InviteDialog({
  project,
  publicUrl,
  onClose,
  onSettings,
}: {
  project: Project;
  publicUrl: string;
  onClose: () => void;
  onSettings: () => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  async function generate() {
    setBusy(true);
    setError('');
    try {
      const invitation = await api.invite(project.id);
      setUrl(`${publicUrl || localUrl()}/#invite=${invitation.token}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={`Пригласить в ${project.name}`} onClose={onClose}>
      <div className="invite-symbol">
        <Link size={25} />
      </div>
      <p className="dialog-description">
        Коллега сможет писать в чат, ставить задачи агенту и видеть результат. Расширенные
        разрешения подтверждаете вы.
      </p>
      {!publicUrl ? (
        <div className="info-notice">
          Сейчас ссылка будет доступна только на этом Mac. Для коллеги укажите адрес Tailscale
          Funnel в настройках.
          <button className="text-button" onClick={onSettings}>
            Настроить общий доступ <span>↗</span>
          </button>
        </div>
      ) : null}
      <div className="invite-details">
        <ShieldCheck size={16} />
        <span>Один участник · действует 24 часа</span>
      </div>
      {url ? (
        <>
          <label>
            Ссылка-приглашение
            <div className="input-action">
              <input
                value={url}
                readOnly
                aria-label="Ссылка-приглашение"
                onFocus={(e) => e.target.select()}
              />
              <button
                className="secondary-button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(url)
                    .then(() => setCopied(true))
                    .catch(() => setError('Выделите и скопируйте ссылку вручную.'))
                }
              >
                {copied ? <Check size={17} /> : <Copy size={17} />}
              </button>
            </div>
          </label>
          <p className="muted small-text">
            После первого подключения ссылка перестанет действовать.
          </p>
        </>
      ) : null}
      <ErrorNotice text={error} />
      <footer>
        <button
          className="text-button danger"
          onClick={() =>
            void api
              .revokeInvites(project.id)
              .then(() => {
                setUrl('');
                setError('');
              })
              .catch((e) => setError(e.message))
          }
        >
          Отозвать ссылки
        </button>
        <button className="primary-button" disabled={busy} onClick={() => void generate()}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <Link size={16} />}{' '}
          {url ? 'Ещё приглашение' : 'Создать ссылку'}
        </button>
      </footer>
    </Modal>
  );
}
export function SettingsDialog({
  ownerName,
  publicUrl,
  onClose,
  onSaved,
}: {
  ownerName: string;
  publicUrl: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(ownerName);
  const [url, setUrl] = useState(publicUrl);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.settings(name, url);
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Настройки" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Ваше имя
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          <small>Так вас видят другие участники чата.</small>
        </label>
        <label>
          Адрес для совместной работы
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-mac.your-tailnet.ts.net"
          />
          <small>
            Укажите адрес уже настроенного Tailscale Funnel, направленного на этот сервер.
          </small>
        </label>
        <div className="settings-server">
          <span className="live-dot" />
          Локальный сервер<code>{localUrl()}</code>
        </div>
        <p className="muted small-text">
          Mac должен оставаться включённым и подключённым к интернету. Настройка адреса сама по себе
          не включает Funnel.
        </p>
        <ErrorNotice text={error} />
        <footer>
          <button type="button" className="secondary-button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary-button" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : null}Сохранить
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function EntryScreen({ error, onLogin }: { error: string; onLogin: () => Promise<void> }) {
  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  const [details, setDetails] = useState<{ name: string; owner: string } | null>(null);
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [localError, setLocalError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ownerLogin, setOwnerLogin] = useState(false);
  useEffect(() => {
    if (invite)
      void api
        .invitation(invite)
        .then(setDetails)
        .catch((e) => setLocalError(e.message));
  }, [invite]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLocalError('');
    try {
      if (invite) {
        await api.join(invite, name);
        setOwnerToken('');
        history.replaceState(null, '', location.pathname);
      } else setOwnerToken(key.trim());
      await onLogin();
    } catch (e) {
      setLocalError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="entry-screen">
      <div className="entry-card">
        <Logo />
        <div className="entry-icon">
          <ShieldCheck size={28} />
        </div>
        <h1>
          {details
            ? `Присоединиться к ${details.name}`
            : invite
              ? 'Приглашение в проект'
              : 'Ваш проект. Ваша команда.'}
        </h1>
        <p>
          {details
            ? `${details.owner} приглашает вас в общий чат с агентом.`
            : 'Откройте приложение Plus на Mac или перейдите по ссылке-приглашению от коллеги.'}
        </p>
        <ErrorNotice
          text={localError || (!invite && error && !error.includes('Войдите') ? error : '')}
        />
        {invite && details ? (
          <form onSubmit={submit}>
            <label>
              Как вас зовут?
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={60}
                placeholder="Ваше имя"
                autoFocus
              />
            </label>
            <button className="primary-button full" disabled={busy || !name.trim()}>
              {busy ? <LoaderCircle size={16} className="spin" /> : null}Присоединиться к чату
            </button>
          </form>
        ) : !invite ? (
          <>
            <button className="text-button" onClick={() => setOwnerLogin(!ownerLogin)}>
              Вход владельца в браузере
            </button>
            {ownerLogin ? (
              <form onSubmit={submit}>
                <label>
                  Локальный ключ владельца
                  <input
                    type="password"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    required
                    autoComplete="off"
                  />
                </label>
                <small className="muted">
                  Ключ хранится в owner.key в каталоге данных Plus. В desktop-приложении вход
                  автоматический.
                </small>
                <button className="primary-button full" disabled={busy || !key}>
                  Подключиться
                </button>
              </form>
            ) : null}
          </>
        ) : null}
        <div className="entry-footnote">
          <span className="live-dot" />
          Выполнение на компьютере владельца
        </div>
      </div>
    </main>
  );
}

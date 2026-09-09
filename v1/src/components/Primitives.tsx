import { useEffect, useRef, type ReactNode } from 'react';
import { X, Plus } from 'lucide-react';

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`logo ${small ? 'small' : ''}`}>
      <Plus aria-hidden="true" />
      <span>Plus</span>
    </span>
  );
}
export function Avatar({
  name,
  agent = false,
  small = false,
}: {
  name: string;
  agent?: boolean;
  small?: boolean;
}) {
  return (
    <span className={`avatar ${agent ? 'agent' : ''} ${small ? 'small' : ''}`} aria-label={name}>
      {agent ? <Plus size={17} /> : name.slice(0, 1).toUpperCase()}
    </span>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Закрыть">
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function ErrorNotice({ text }: { text: string }) {
  return text ? (
    <div className="error-notice" role="alert">
      {text}
    </div>
  ) : null;
}

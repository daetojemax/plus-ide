import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, bootstrap, connectEvents, type ClientSnapshot } from './api';
import type { AppEvent } from '../shared/protocol';

export function useWorkspace() {
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<'online' | 'offline' | 'connecting'>('connecting');
  const [streams, setStreams] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState(localStorage.getItem('plus-project') || '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fetching = useRef(false);
  const again = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (fetching.current) {
      again.current = true;
      return;
    }
    fetching.current = true;
    try {
      const data = await api.snapshot();
      if (!mounted.current) return;
      setSnapshot(data);
      setError('');
      setSelected((current) =>
        data.projects.some((p) => p.id === current) ? current : data.projects[0]?.id || '',
      );
      setStreams((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key]) =>
              !data.messages.some((m) => m.id === key) &&
              data.tasks.some(
                (t) => key.startsWith(`${t.id}:`) && ['running', 'waiting'].includes(t.status),
              ),
          ),
        ),
      );
    } catch (e) {
      if (mounted.current) {
        if (e instanceof ApiError && e.status === 401) setSnapshot(null);
        setError(e instanceof Error ? e.message : 'Сервер недоступен');
      }
    } finally {
      fetching.current = false;
      if (mounted.current) setLoaded(true);
      if (again.current) {
        again.current = false;
        void refresh();
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void bootstrap()
      .then(refresh)
      .catch((e) => {
        setError(String(e));
        setLoaded(true);
      });
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, [refresh]);
  const identity = snapshot?.me.id;
  useEffect(() => {
    if (!identity) return;
    const onEvent = (event: AppEvent) => {
      if (event.type === 'agent.delta' && event.payload) {
        const { taskId, itemId, text } = event.payload;
        setStreams((current) => ({
          ...current,
          [`${taskId}:${itemId}`]: (current[`${taskId}:${itemId}`] || '') + text,
        }));
      } else if (event.type === 'activity' && event.payload) {
        const { taskId, text } = event.payload;
        setSnapshot((current) =>
          current
            ? {
                ...current,
                tasks: current.tasks.map((t) => (t.id === taskId ? { ...t, activity: text } : t)),
              }
            : current,
        );
      } else {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void refresh(), 80);
      }
    };
    return connectEvents(onEvent, setConnection, () => void refresh());
  }, [identity, refresh]);
  const select = useCallback((id: string) => {
    setSelected(id);
    localStorage.setItem('plus-project', id);
  }, []);
  return { snapshot, loaded, error, connection, streams, selected, select, refresh };
}

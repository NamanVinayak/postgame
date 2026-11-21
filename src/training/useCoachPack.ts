import { useCallback, useEffect, useRef, useState } from 'react';
import { clearCachedPack, getCachedPack, saveCachedPack } from '../services/storage';
import { clearCoachPackUrl, consumeCoachParam, getCoachPackUrl, setCoachPackUrl } from './coachLink';
import { parsePack, type CoachPack } from './pack';
import { TRAIN_COPY } from './copy';

export interface CoachPackState {
  url: string | null;
  pack: CoachPack | null;
  status: 'none' | 'loading' | 'ready' | 'stale' | 'error';
  message: string | null;
  refresh: () => void;
  link: (url: string) => boolean;
  unlink: () => void;
}

/** The linked coach pack: last saved copy first, then a fresh fetch (also when the app comes back to view). */
export function useCoachPack(): CoachPackState {
  const [url, setUrl] = useState<string | null>(() => consumeCoachParam() ?? getCoachPackUrl());
  const [pack, setPack] = useState<CoachPack | null>(null);
  const [status, setStatus] = useState<CoachPackState['status']>(url ? 'loading' : 'none');
  const [message, setMessage] = useState<string | null>(null);
  const hasPack = useRef(false);
  const generation = useRef(0);

  const load = useCallback(async (target: string, gen: number) => {
    const live = () => gen === generation.current;
    if (!hasPack.current) {
      const cached = await getCachedPack();
      if (!live()) return;
      if (cached) {
        hasPack.current = true;
        setPack(cached);
        setStatus('stale');
      }
    }
    try {
      const res = await fetch(target, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const fresh = parsePack(await res.json());
      if (!live()) return;
      hasPack.current = true;
      setPack(fresh);
      setStatus('ready');
      setMessage(null);
      await saveCachedPack(fresh);
    } catch {
      if (!live()) return;
      if (hasPack.current) {
        setStatus('stale');
        setMessage(TRAIN_COPY.stale);
      } else {
        setStatus('error');
        setMessage(TRAIN_COPY.loadError);
      }
    }
  }, []);

  const refresh = useCallback(() => {
    if (url) void load(url, generation.current);
  }, [url, load]);

  useEffect(() => {
    generation.current += 1;
    if (!url) return;
    const gen = generation.current;
    void load(url, gen);
    let lastAt = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastAt < 2000) return;
      lastAt = Date.now();
      void load(url, gen);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [url, load]);

  const link = useCallback(
    (next: string) => {
      if (!setCoachPackUrl(next)) return false;
      const saved = getCoachPackUrl();
      hasPack.current = false;
      setPack(null);
      setStatus('loading');
      setMessage(null);
      void clearCachedPack();
      if (saved === url && saved) void load(saved, generation.current);
      else setUrl(saved);
      return true;
    },
    [url, load],
  );

  const unlink = useCallback(() => {
    clearCoachPackUrl();
    void clearCachedPack();
    hasPack.current = false;
    generation.current += 1;
    setUrl(null);
    setPack(null);
    setStatus('none');
    setMessage(null);
  }, []);

  return { url, pack, status, message, refresh, link, unlink };
}

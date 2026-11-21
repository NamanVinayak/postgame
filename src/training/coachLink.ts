const COACH_URL_KEY = 'postgame.coachPackUrl';
const PARAM = 'coach';

function asHttps(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function getCoachPackUrl(): string | null {
  return localStorage.getItem(COACH_URL_KEY);
}

/** Saves the link if it is an https URL; returns false (and saves nothing) otherwise. */
export function setCoachPackUrl(url: string): boolean {
  const clean = asHttps(url);
  if (!clean) return false;
  localStorage.setItem(COACH_URL_KEY, clean);
  return true;
}

export function clearCoachPackUrl(): void {
  localStorage.removeItem(COACH_URL_KEY);
}

/** Reads ?coach=<url> from the address bar, saves it if valid, and removes it from the address bar. */
export function consumeCoachParam(): string | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get(PARAM);
  if (raw === null) return null;
  params.delete(PARAM);
  const search = params.toString();
  const { pathname, hash } = window.location;
  window.history.replaceState(window.history.state, '', `${pathname}${search ? `?${search}` : ''}${hash}`);
  return setCoachPackUrl(raw) ? getCoachPackUrl() : null;
}

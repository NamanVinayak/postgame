import { registerSW } from 'virtual:pwa-register';

/*
 * Keeps an installed copy of the app on the latest deploy.
 *
 * A phone that resumes the app (home-screen PWA, or a tab brought back from the background)
 * never navigates, so the browser never re-checks for a new version, and even when a new
 * service worker takes over (sw.js calls skipWaiting + clientsClaim) the page keeps running
 * its old JavaScript. That is how a phone ended up scoring games with a weeks-old build:
 * docs/incidents/2026-11-23-old-app-copy-wrong-accuracy.md.
 *
 * So: check for a new version on start, on every return to the foreground and hourly; when a
 * new worker takes control, reload once into it, but never while something holds the reload
 * (an analysis in progress). Any change here needs the real-browser check in that note.
 */

/** How often an open app checks for a new version (it also checks on start and on every return to the foreground). */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface AppUpdatesDeps {
  /** vite-plugin-pwa's registration; tests inject a fake. */
  register?: typeof registerSW;
  reload?: () => void;
  /** Defaults to `navigator.serviceWorker`; null means service workers aren't available. */
  serviceWorker?: ServiceWorkerContainer | null;
  intervalMs?: number;
}

export interface AppUpdates {
  /** Registers the service worker and starts the update checks. Returns a function that stops them. */
  start(): () => void;
  /** Delays any update reload until the returned function is called (calling it twice is harmless). */
  holdReload(): () => void;
}

export function createAppUpdates({
  register = registerSW,
  reload = () => window.location.reload(),
  serviceWorker,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
}: AppUpdatesDeps = {}): AppUpdates {
  let holds = 0;
  let reloadPending = false;
  let reloaded = false;

  function reloadIfClear() {
    if (!reloadPending || holds > 0 || reloaded) return;
    reloaded = true;
    reload();
  }

  function requestReload() {
    reloadPending = true;
    reloadIfClear();
  }

  function holdReload() {
    holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds -= 1;
      reloadIfClear();
    };
  }

  function start() {
    const sw = serviceWorker === undefined ? (navigator.serviceWorker ?? null) : serviceWorker;
    if (!sw) return () => {};

    const cleanups: Array<() => void> = [];
    const listen = (target: EventTarget, type: string, handler: (event: Event) => void) => {
      target.addEventListener(type, handler);
      cleanups.push(() => target.removeEventListener(type, handler));
    };

    // A page that started under a worker and sees a new one take control is running old JS.
    // On a first visit no worker controlled the page; the one that claims it is this same version.
    let controlled = Boolean(sw.controller);
    listen(sw, 'controllerchange', () => {
      if (controlled) requestReload();
      controlled = true;
    });

    let stopped = false;
    // Registers after the page's load event, as the plugin's old injected registerSW.js did.
    register({
      // Without this the plugin reloads by itself when a new worker activates, ignoring holds.
      onNeedReload: requestReload,
      onRegisteredSW(_swUrl, registration) {
        if (!registration || stopped) return;
        const check = () => {
          registration.update().catch(() => {
            // Offline, or the worker went away: the next foreground or hourly check tries again.
          });
        };
        check();
        listen(document, 'visibilitychange', () => {
          if (document.visibilityState === 'visible') check();
        });
        listen(window, 'pageshow', (event) => {
          if ((event as PageTransitionEvent).persisted) check(); // restored from the back/forward cache
        });
        const timer = setInterval(check, intervalMs);
        cleanups.push(() => clearInterval(timer));
      },
    });

    return () => {
      stopped = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
    };
  }

  return { start, holdReload };
}

const appUpdates = createAppUpdates();

/** Call once at startup (src/main.tsx). */
export const startAppUpdates = appUpdates.start;
/** Hold the update reload while work that must not be interrupted runs (see ReviewScreen). */
export const holdReload = appUpdates.holdReload;

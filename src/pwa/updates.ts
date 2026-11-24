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
 * So: check for a new version on start, on every return to the foreground and hourly. When a
 * new worker takes control, reload once into it at a safe moment. The app has no routing, so a
 * reload lands on the game list:
 *   - not while an analysis is running on its review screen (`holdReload`), not even in the
 *     background; leaving the review mid-run ends the hold, and the reload drops that run;
 *   - while a review or drill is on screen (`holdReloadWhileVisible`), wait until the user is
 *     back on the list or the app goes to the background; then the user comes back to the game
 *     list on the new version (an in-memory drill session is lost).
 * Any change here needs the real-browser check in that note.
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
  /** Blocks the update reload, even in the background, until released (releasing twice is harmless). */
  holdReload(): () => void;
  /** Blocks the update reload while the app is on screen; in the background it may still happen. */
  holdReloadWhileVisible(): () => void;
}

export function createAppUpdates({
  register = registerSW,
  reload = () => window.location.reload(),
  serviceWorker,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
}: AppUpdatesDeps = {}): AppUpdates {
  let holds = 0;
  let visibleHolds = 0;
  let reloadPending = false;
  let reloaded = false;

  function reloadIfSafe() {
    if (!reloadPending || reloaded || holds > 0) return;
    if (visibleHolds > 0 && document.visibilityState !== 'hidden') return;
    reloaded = true;
    reload();
  }

  function requestReload() {
    reloadPending = true;
    reloadIfSafe();
  }

  function hold(onlyWhileVisible: boolean) {
    if (onlyWhileVisible) visibleHolds += 1;
    else holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (onlyWhileVisible) visibleHolds -= 1;
      else holds -= 1;
      reloadIfSafe();
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
    const controllerAtStart = sw.controller;
    let controlled = Boolean(controllerAtStart);
    listen(sw, 'controllerchange', () => {
      if (controlled) requestReload();
      controlled = true;
    });

    let registration: ServiceWorkerRegistration | undefined;
    const check = () => {
      registration?.update().catch(() => {
        // Offline, or the worker went away: the next foreground or hourly check tries again.
      });
    };
    listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
      else reloadIfSafe(); // in the background a reload is invisible: switch now if one is waiting
    });
    listen(window, 'pageshow', (event) => {
      if (!(event as PageTransitionEvent).persisted) return;
      // Restored from the back/forward cache. A reload started before the page was cached can be
      // dropped, leaving this restored page on the old code: allow it once more.
      if (reloaded) {
        reloaded = false;
        reloadIfSafe();
      }
      check();
    });

    let stopped = false;
    // Registers after the page's load event, as the plugin's old injected registerSW.js did.
    register({
      // Without this the plugin reloads by itself when a new worker activates, ignoring holds.
      onNeedReload() {
        // workbox-window also reports "activated" for the worker this page already runs under
        // (it was still activating when the page loaded, e.g. right after an update reload).
        // Nothing new then; a genuinely new worker arrives through 'controllerchange' anyway.
        if (sw.controller && sw.controller === controllerAtStart) return;
        requestReload();
      },
      onRegisteredSW(_swUrl, reg) {
        if (!reg || stopped) return;
        registration = reg;
        check();
        const timer = setInterval(check, intervalMs);
        cleanups.push(() => clearInterval(timer));
      },
    });

    return () => {
      stopped = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
    };
  }

  return { start, holdReload: () => hold(false), holdReloadWhileVisible: () => hold(true) };
}

const appUpdates = createAppUpdates();

/** Call once at startup (src/main.tsx). */
export const startAppUpdates = appUpdates.start;
/** Hold the update reload while work that must not be interrupted runs (an analysis; see ReviewScreen). */
export const holdReload = appUpdates.holdReload;
/** Hold the update reload while a screen other than the game list is in view (see App). */
export const holdReloadWhileVisible = appUpdates.holdReloadWhileVisible;

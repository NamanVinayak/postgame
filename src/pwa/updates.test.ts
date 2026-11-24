import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RegisterSWOptions } from 'vite-plugin-pwa/types';

// The real virtual module only exists inside a Vite build; every test injects its own `register`.
vi.mock('virtual:pwa-register', () => ({ registerSW: vi.fn() }));
import { createAppUpdates, UPDATE_CHECK_INTERVAL_MS } from './updates';

/** Stop functions of updaters started by the current test (their listeners live on document/window). */
const running: Array<() => void> = [];

/** Starts an updater against a fake service-worker container and registration. */
function start({
  controller = {} as object | null,
  update = () => Promise.resolve(),
}: { controller?: object | null; update?: () => Promise<unknown> } = {}) {
  const registration = { update: vi.fn(update) };
  let options: RegisterSWOptions = {};
  const register = vi.fn((opts: RegisterSWOptions = {}) => {
    options = opts;
    opts.onRegisteredSW?.('/postgame/sw.js', registration as unknown as ServiceWorkerRegistration);
    return async () => {};
  });
  const reload = vi.fn();
  const serviceWorker = Object.assign(new EventTarget(), { controller }) as unknown as ServiceWorkerContainer;
  const updates = createAppUpdates({ register, reload, serviceWorker });
  const stop = updates.start();
  running.push(stop);
  return {
    registration,
    register,
    reload,
    updates,
    stop,
    serviceWorker,
    pluginOptions: () => options,
    /** What the browser does when a new service worker calls clients.claim(). */
    newWorkerTakesControl: () => {
      (serviceWorker as { controller: object | null }).controller = {};
      serviceWorker.dispatchEvent(new Event('controllerchange'));
    },
  };
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  while (running.length) running.pop()!();
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

describe('app updates', () => {
  test('checksForUpdateOnStart', () => {
    const { register, registration } = start();
    expect(register).toHaveBeenCalledTimes(1);
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  test('checksForUpdateWhenVisible', () => {
    const { registration } = start();
    registration.update.mockClear();

    setVisibility('hidden');
    expect(registration.update).not.toHaveBeenCalled();

    setVisibility('visible');
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  test('checksForUpdateWhenRestoredFromBackForwardCache', () => {
    const { registration } = start();
    registration.update.mockClear();

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    expect(registration.update).not.toHaveBeenCalled();

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  test('checksForUpdatePeriodically', () => {
    vi.useFakeTimers();
    const { registration } = start();
    registration.update.mockClear();

    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(registration.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(registration.update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
    expect(registration.update).toHaveBeenCalledTimes(2);
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  test('stopsCheckingWhenStopped', () => {
    vi.useFakeTimers();
    const { registration, stop } = start();
    registration.update.mockClear();
    stop();

    setVisibility('visible');
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(registration.update).not.toHaveBeenCalled();
  });

  test('ignoresFailedUpdateChecks', async () => {
    // Offline, or the worker is gone: a failed check must not surface as an error.
    const { registration } = start({ update: () => Promise.reject(new Error('offline')) });
    setVisibility('visible');
    await Promise.resolve();
    expect(registration.update).toHaveBeenCalledTimes(2);
  });

  test('reloadsOnceWhenNewWorkerTakesControl', () => {
    const { reload, newWorkerTakesControl, pluginOptions } = start();
    expect(reload).not.toHaveBeenCalled();

    newWorkerTakesControl();
    expect(reload).toHaveBeenCalledTimes(1);

    // A second claim, or the plugin's own "activated" signal, must not reload again.
    newWorkerTakesControl();
    pluginOptions().onNeedReload?.();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('doesNotReloadOnFirstInstall', () => {
    // First visit: no worker controlled the page, so the one that claims it is this same version.
    const { reload, newWorkerTakesControl } = start({ controller: null });
    newWorkerTakesControl();
    expect(reload).not.toHaveBeenCalled();

    // A genuinely new version later in the same session does reload.
    newWorkerTakesControl();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('routesThePluginReloadThroughTheSameGate', () => {
    // vite-plugin-pwa reloads by itself on "activated" unless onNeedReload is given.
    const { reload, updates, pluginOptions, serviceWorker } = start();
    expect(pluginOptions().onNeedReload).toBeTypeOf('function');

    const release = updates.holdReload();
    (serviceWorker as { controller: object | null }).controller = {}; // a new worker controls the page
    pluginOptions().onNeedReload!();
    expect(reload).not.toHaveBeenCalled();
    release();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('ignoresThePluginSignalForTheWorkerAlreadyInControl', () => {
    // Just reloaded into a new version whose worker was still activating: workbox-window reports
    // "activated, isUpdate", but this page already runs under that worker. No second reload.
    const { reload, pluginOptions, newWorkerTakesControl } = start();
    pluginOptions().onNeedReload!();
    expect(reload).not.toHaveBeenCalled();

    newWorkerTakesControl(); // a genuinely newer version still reloads
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('retriesTheReloadAfterABackForwardCacheRestore', () => {
    // The reload can be dropped while the page is being put into the back/forward cache;
    // a restored page would otherwise keep running the old code.
    const { reload, newWorkerTakesControl } = start();
    newWorkerTakesControl();
    expect(reload).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    expect(reload).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  test('aBackForwardCacheRestoreWithNothingPendingDoesNotReload', () => {
    const { reload } = start();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(reload).not.toHaveBeenCalled();
  });

  test('waitsForAnalysisToFinishBeforeReload', () => {
    const { reload, updates, newWorkerTakesControl } = start();
    const releaseAnalysis = updates.holdReload();

    newWorkerTakesControl();
    expect(reload).not.toHaveBeenCalled();

    releaseAnalysis();
    expect(reload).toHaveBeenCalledTimes(1);

    releaseAnalysis(); // releasing twice (finish + leave the screen) is harmless
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('waitsForEveryHoldBeforeReload', () => {
    const { reload, updates, newWorkerTakesControl } = start();
    const first = updates.holdReload();
    const second = updates.holdReload();
    newWorkerTakesControl();

    first();
    first();
    expect(reload).not.toHaveBeenCalled();
    second();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('reloadsImmediatelyOnGameList', () => {
    // Game list or connect screen, nothing running: nothing to lose, so switch right away.
    const { reload, newWorkerTakesControl } = start();
    newWorkerTakesControl();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('defersReloadWhileReviewingThenReloadsWhenHidden', () => {
    // A reload lands on the game list (no routing), so an open review or drill must not be yanked away.
    const { reload, updates, newWorkerTakesControl } = start();
    updates.holdReloadWhileVisible();

    newWorkerTakesControl();
    setVisibility('visible');
    expect(reload).not.toHaveBeenCalled();

    setVisibility('hidden'); // the app went to the background: the reload is invisible now
    expect(reload).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    setVisibility('hidden');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('defersReloadWhileReviewingThenReloadsBackOnTheList', () => {
    const { reload, updates, newWorkerTakesControl } = start();
    const leaveReview = updates.holdReloadWhileVisible();
    newWorkerTakesControl();
    expect(reload).not.toHaveBeenCalled();

    leaveReview();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('reloadsAtOnceIfTheUpdateArrivesWhileHidden', () => {
    const { reload, updates, newWorkerTakesControl } = start();
    updates.holdReloadWhileVisible();
    setVisibility('hidden');
    newWorkerTakesControl();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('neverReloadsMidAnalysisEvenWhenHidden', () => {
    const { reload, updates, newWorkerTakesControl } = start();
    const onReview = updates.holdReloadWhileVisible();
    const analysis = updates.holdReload();
    newWorkerTakesControl();

    setVisibility('hidden');
    expect(reload).not.toHaveBeenCalled();

    setVisibility('visible');
    analysis(); // finished, but the finished review is still on screen
    expect(reload).not.toHaveBeenCalled();

    setVisibility('hidden');
    expect(reload).toHaveBeenCalledTimes(1);
    onReview();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('aHoldWithNoPendingUpdateNeverReloads', () => {
    const { reload, updates } = start();
    updates.holdReload()();
    updates.holdReloadWhileVisible()();
    setVisibility('hidden');
    expect(reload).not.toHaveBeenCalled();
  });

  test('doesNothingWithoutServiceWorkerSupport', () => {
    const register = vi.fn();
    const updates = createAppUpdates({ register, reload: vi.fn(), serviceWorker: null });
    const stop = updates.start();
    expect(register).not.toHaveBeenCalled();
    stop();
  });
});

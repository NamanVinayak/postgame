/**
 * Which copy of the app this device is running: commit + build date, stamped at build time.
 * Phones keep a cached copy of the app, so this is how anyone checks they have the latest.
 */
export function AppVersion() {
  return (
    <p className="app-version">
      Version {__APP_COMMIT__} · {__APP_BUILD_DATE__}
    </p>
  );
}

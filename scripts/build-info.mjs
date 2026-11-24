// Build-time stamp for the app's version line (injected via `define` in vite.config.ts).
// Plain JS so vite.config.ts stays type-checkable without Node's type definitions.
import { execSync } from 'node:child_process';

/** Short commit SHA: GITHUB_SHA in CI, `git rev-parse` locally, "dev" when neither is available. */
export function commitSha() {
  const fromCi = process.env.GITHUB_SHA;
  if (fromCi) return fromCi.slice(0, 7);
  try {
    const sha = execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return sha || 'dev';
  } catch {
    return 'dev';
  }
}

/** The build's date in UTC, YYYY-MM-DD. */
export function buildDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

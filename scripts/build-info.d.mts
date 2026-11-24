/** Short commit SHA: GITHUB_SHA in CI, `git rev-parse` locally, "dev" when neither is available. */
export function commitSha(): string;

/** The build's date in UTC, YYYY-MM-DD. */
export function buildDate(now?: Date): string;

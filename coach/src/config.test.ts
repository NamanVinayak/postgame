import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coachHome, ensureDirs, loadLocalConfig } from './config';

describe('config', () => {
  let dir: string;
  const prev = process.env.POSTGAME_COACH_HOME;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'postgame-coach-'));
    process.env.POSTGAME_COACH_HOME = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.POSTGAME_COACH_HOME;
    else process.env.POSTGAME_COACH_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it('coachHomeHonoursEnv', () => {
    expect(coachHome()).toBe(dir);
    ensureDirs();
    for (const sub of ['cache', 'snapshots', 'packs']) {
      expect(existsSync(join(dir, sub))).toBe(true);
    }
  });

  it('loadLocalConfigDefaults', () => {
    expect(loadLocalConfig()).toEqual({
      excludeAccounts: [],
      stockfishPath: process.env.STOCKFISH_PATH ?? '/opt/homebrew/bin/stockfish',
    });
  });
});

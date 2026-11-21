import { describe, expect, test } from 'vitest';
import { openDB } from 'idb';
import { SCHEMA_VERSION } from '../constants';

describe('database upgrade v1 → v2', () => {
  test('keeps existing analyses and adds the training stores', async () => {
    const v1 = await openDB('postgame', 1, {
      upgrade(db) {
        db.createObjectStore('analyses', { keyPath: 'gameId' });
      },
    });
    await v1.put('analyses', { gameId: 'g1', schemaVersion: SCHEMA_VERSION, whiteAccuracy: 1, blackAccuracy: 2 });
    v1.close();

    const storage = await import('./storage');
    expect(await storage.getAnalysis('g1')).toMatchObject({ gameId: 'g1' });
    await storage.saveProgress({ drillId: 'd', box: 2, dueAt: 5, lapses: 0, reviews: 1, lastPositionIndex: 0 });
    expect((await storage.getAllProgress()).get('d')).toMatchObject({ box: 2 });
  });
});

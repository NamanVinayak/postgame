import { beforeEach, describe, expect, test } from 'vitest';
import { clearCoachPackUrl, consumeCoachParam, getCoachPackUrl, setCoachPackUrl } from './coachLink';

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('coach link', () => {
  test('only https links are saved', () => {
    expect(setCoachPackUrl('http://example.com/p.json')).toBe(false);
    expect(setCoachPackUrl('not a url')).toBe(false);
    expect(getCoachPackUrl()).toBeNull();
    expect(setCoachPackUrl('  https://example.com/p.json ')).toBe(true);
    expect(getCoachPackUrl()).toBe('https://example.com/p.json');
    clearCoachPackUrl();
    expect(getCoachPackUrl()).toBeNull();
  });

  test('?coach= is saved and removed from the address bar', () => {
    window.history.replaceState({}, '', '/postgame/?coach=https%3A%2F%2Fexample.com%2Fp.json&x=1#top');
    expect(consumeCoachParam()).toBe('https://example.com/p.json');
    expect(getCoachPackUrl()).toBe('https://example.com/p.json');
    expect(window.location.search).toBe('?x=1');
    expect(window.location.pathname).toBe('/postgame/');
    expect(window.location.hash).toBe('#top');
  });

  test('a bad ?coach= is removed but not saved', () => {
    window.history.replaceState({}, '', '/?coach=javascript%3Aalert(1)');
    expect(consumeCoachParam()).toBeNull();
    expect(getCoachPackUrl()).toBeNull();
    expect(window.location.search).toBe('');
  });

  test('no param: nothing happens', () => {
    expect(consumeCoachParam()).toBeNull();
  });
});

import { Chess } from 'chess.js';

/** A coach pack: drills built from one player's own repeated mistakes (see README "Train"). */
export interface PackUsual {
  move: string;
  times: number;
  punish: string[];
  why: string;
}
export interface PackPosition {
  id: string;
  moves: string[];
  prompt: string;
  best: string;
  accept: string[];
  whyRight: string;
  usual: PackUsual[];
}
export interface PackDrill {
  id: string;
  opening: string;
  status: 'active' | 'retired';
  idea: string;
  seen: number;
  wrong: number;
  realGames: { right: number; needed: number };
  positions: PackPosition[];
}
export interface PackOpening {
  key: string;
  name: string;
  side: 'white' | 'black';
}
export interface CoachPack {
  schema: 1;
  generated: string;
  openings: PackOpening[];
  drills: PackDrill[];
}

export class PackError extends Error {}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Board after replaying SAN from the start, or null if any move is illegal. */
function replay(moves: string[]): Chess | null {
  const chess = new Chess();
  try {
    for (const san of moves) chess.move(san);
  } catch {
    return null;
  }
  return chess;
}

function legalIn(fen: string, san: string): boolean {
  try {
    new Chess(fen).move(san);
    return true;
  } catch {
    return false;
  }
}

function parsePosition(raw: unknown): PackPosition | null {
  if (!isObj(raw)) return null;
  const moves = strList(raw.moves);
  const board = replay(moves);
  if (!board) return null;
  const fen = board.fen();
  const accept = strList(raw.accept).filter((san) => legalIn(fen, san));
  if (accept.length === 0) return null;
  const best = accept.includes(str(raw.best)) ? str(raw.best) : accept[0];
  const usual: PackUsual[] = (Array.isArray(raw.usual) ? raw.usual : [])
    .filter(isObj)
    .map((u) => ({ move: str(u.move), times: num(u.times), punish: strList(u.punish), why: str(u.why) }))
    .filter((u) => legalIn(fen, u.move));
  return {
    id: str(raw.id),
    moves,
    prompt: str(raw.prompt),
    best,
    accept,
    whyRight: str(raw.whyRight),
    usual,
  };
}

function parseDrill(raw: unknown, openings: Set<string>): PackDrill | null {
  if (!isObj(raw) || !str(raw.id) || !openings.has(str(raw.opening))) return null;
  const positions = (Array.isArray(raw.positions) ? raw.positions : [])
    .map(parsePosition)
    .filter((p): p is PackPosition => p !== null);
  if (positions.length === 0) return null;
  const rg = isObj(raw.realGames) ? raw.realGames : {};
  return {
    id: str(raw.id),
    opening: str(raw.opening),
    status: raw.status === 'retired' ? 'retired' : 'active',
    idea: str(raw.idea),
    seen: num(raw.seen),
    wrong: num(raw.wrong),
    realGames: { right: num(rg.right), needed: num(rg.needed, 3) },
    positions,
  };
}

/** Validate an untrusted pack. Broken drills/positions are dropped; a pack that isn't one throws PackError. */
export function parsePack(json: unknown): CoachPack {
  if (!isObj(json)) throw new PackError('Not a coach file.');
  if (json.schema !== 1) throw new PackError(`Unsupported coach file version: ${String(json.schema)}`);
  if (!Array.isArray(json.drills) || !Array.isArray(json.openings)) throw new PackError('Not a coach file.');
  const openings: PackOpening[] = json.openings
    .filter(isObj)
    .map((o) => ({ key: str(o.key), name: str(o.name), side: o.side === 'black' ? 'black' : 'white' }) as PackOpening)
    .filter((o) => o.key);
  const keys = new Set(openings.map((o) => o.key));
  const drills = json.drills.map((d) => parseDrill(d, keys)).filter((d): d is PackDrill => d !== null);
  return { schema: 1, generated: str(json.generated), openings, drills };
}

/** FEN after replaying SAN moves from the starting position. */
export function positionFen(moves: string[]): string {
  const board = replay(moves);
  if (!board) throw new PackError(`Illegal line: ${moves.join(' ')}`);
  return board.fen();
}

export function sideToMove(position: PackPosition): 'white' | 'black' {
  return position.moves.length % 2 === 0 ? 'white' : 'black';
}

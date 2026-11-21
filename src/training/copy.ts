/** Every sentence the Train section shows that doesn't come from the coach pack. Plain words only. */
export const TRAIN_COPY = {
  stale: 'Showing your last saved drills.',
  loadError: 'Couldn’t load your coach file.',
  badLink: 'That link needs to start with https://',
  train: 'Train',
  todaysDrills: 'Today’s drills',
  nothingDue: 'Nothing due — come back tomorrow.',
  copyProgress: 'Copy progress for coach',
  copied: 'Copied — paste it into your coaching chat.',
  unlink: 'Unlink coaching',
  haveLink: 'Have a coach link?',
  pasteLink: 'Paste coach link',
  linkButton: 'Link',
  yourMove: 'Your move.',
  knewIt: 'Knew it',
  guessed: 'Guessed',
  next: 'Next',
  notQuite: 'Not quite.',
  yourTurn: 'Your turn — play it.',
  done: 'Done for today',
  backToTrain: 'Back to Train',
  showBetter: 'Show me the better move',
  followArrow: 'Not that one — follow the green arrow.',
  back: '← Train',
} as const;

export const playedTimes = (n: number): string =>
  n === 1 ? 'You’ve played this once before.' : `You’ve played this ${n} times.`;

export const fixedInRealGames = (right: number, needed: number): string =>
  `Fixed in real games: ${right} of ${needed}`;

export const trainedDays = (k: number): string => `Trained ${k} of the last 7 days`;

export const learnedOf = (learned: number, total: number): string => `${learned} of ${total} learned`;

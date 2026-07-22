import type { GameSummary, TimeClass } from '../types';

const TIME_ICON: Record<TimeClass, string> = {
  bullet: '🚀',
  blitz: '⚡',
  rapid: '⏱️',
  daily: '📅',
};

const OUTCOME_LABEL: Record<GameSummary['outcome'], string> = {
  win: 'Win',
  loss: 'Loss',
  draw: 'Draw',
};

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

interface Props {
  game: GameSummary;
  /** Connected user's accuracy; presence means the game is already analyzed. */
  accuracy?: number;
  onSelect: () => void;
}

export function GameRow({ game, accuracy, onSelect }: Props) {
  const analyzed = accuracy !== undefined;
  return (
    <button className="game-row" onClick={onSelect}>
      <span className="tc-icon" aria-label={game.timeClass} title={game.timeClass}>
        {TIME_ICON[game.timeClass]}
      </span>
      <span className="game-main">
        <span className="opponent">
          vs <span className="opponent-name">{game.opponent.username}</span>{' '}
          <span className="rating">({game.opponent.rating})</span>
        </span>
        <span className="game-meta">
          <span className={`chip chip-${game.outcome}`}>{OUTCOME_LABEL[game.outcome]}</span>
          <span className={`color-dot ${game.myColor}`} aria-label={`played ${game.myColor}`} />
          <span className="date">{formatDate(game.endTime)}</span>
        </span>
      </span>
      <span className="game-action">
        {analyzed ? (
          <span className="accuracy">{accuracy.toFixed(0)}% ›</span>
        ) : (
          <span className="analyze-cta">Analyze</span>
        )}
      </span>
    </button>
  );
}

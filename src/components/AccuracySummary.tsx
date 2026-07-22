import type { AnalysisResult, Color } from '../types';
import { CLASS_META } from './classificationMeta';

interface Props {
  analysis: AnalysisResult;
  myColor: Color;
}

const NOTABLE: Array<'blunder' | 'mistake' | 'inaccuracy'> = [
  'blunder',
  'mistake',
  'inaccuracy',
];

export function AccuracySummary({ analysis, myColor }: Props) {
  const myAccuracy = myColor === 'white' ? analysis.whiteAccuracy : analysis.blackAccuracy;
  const oppAccuracy = myColor === 'white' ? analysis.blackAccuracy : analysis.whiteAccuracy;
  const myCounts = analysis.counts[myColor];
  const oppCounts = analysis.counts[myColor === 'white' ? 'black' : 'white'];

  return (
    <div className="accuracy-summary">
      <div className="accuracy-cols">
        <div className="acc-col you">
          <span className="acc-label">You</span>
          <span className="acc-value">{myAccuracy.toFixed(1)}%</span>
        </div>
        <div className="acc-col opp">
          <span className="acc-label">Opponent</span>
          <span className="acc-value">{oppAccuracy.toFixed(1)}%</span>
        </div>
      </div>
      <div className="count-rows">
        {NOTABLE.map((k) => (
          <div className="count-row" key={k}>
            <span className="count-you" style={{ color: CLASS_META[k].color }}>
              {myCounts[k]}
            </span>
            <span className="count-label">{CLASS_META[k].label}s</span>
            <span className="count-opp" style={{ color: CLASS_META[k].color }}>
              {oppCounts[k]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Pulls "System-wide memory free percentage: 63%" out of `memory_pressure` output; null if absent. */
export function parseFreeMemoryPct(output: string): number | null {
  const m = /System-wide memory free percentage:\s*(\d+)\s*%/i.exec(output);
  return m ? Number(m[1]) : null;
}

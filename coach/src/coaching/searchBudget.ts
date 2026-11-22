/**
 * How many deep searches one tool call may still start. It counts only searches that actually
 * run: a result the server already holds, or one read back from the display engine's store on
 * disk, costs nothing, so after a restart known positions never use up the budget.
 */
export interface SearchBudget {
  /** True when `searches` more may start within this budget (and every budget above it). */
  canSpend(searches: number): boolean;
  /** True once a `canSpend` was refused here: the call stopped early and more can be done next time. */
  readonly ranOut: boolean;
}

/**
 * A budget of `limit` searches from now on, read from `searchesRun` (the display engine's count
 * of searches really made, which only grows). With `parent`, both limits apply.
 */
export function searchBudget(limit: number, searchesRun: () => number, parent?: SearchBudget): SearchBudget {
  const start = searchesRun();
  let ranOut = false;
  return {
    canSpend(searches: number): boolean {
      const ok = searchesRun() - start + searches <= limit && (parent ? parent.canSpend(searches) : true);
      if (!ok) ranOut = true;
      return ok;
    },
    get ranOut() {
      return ranOut;
    },
  };
}

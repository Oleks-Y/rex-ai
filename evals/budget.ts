// Budget tracker — hard cap per run + soft cap per task.
//
// Tracks cumulative cost across all rows produced by a single eval
// invocation. The runner asks `tryReserve(cost)` before each row;
// when a row finishes, the runner reports the actual cost back.

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class Budget {
  #spent = 0;
  readonly #cap: number;
  readonly #perTask: number;

  constructor(capUsd: number, perTaskUsd: number) {
    this.#cap = capUsd;
    this.#perTask = perTaskUsd;
  }

  get spent(): number {
    return this.#spent;
  }
  get cap(): number {
    return this.#cap;
  }
  get perTaskCap(): number {
    return this.#perTask;
  }
  get remaining(): number {
    return Math.max(0, this.#cap - this.#spent);
  }

  /** Add to running total. Throws if the cap is exceeded after charging. */
  charge(cost: number): void {
    this.#spent += cost;
    if (this.#spent > this.#cap) {
      throw new BudgetExceededError(
        `budget exhausted: spent $${this.#spent.toFixed(4)} > cap $${this.#cap.toFixed(2)}`,
      );
    }
  }

  /** True if `cost` would exceed the per-task soft cap. */
  exceedsPerTask(cost: number): boolean {
    return cost > this.#perTask;
  }
}

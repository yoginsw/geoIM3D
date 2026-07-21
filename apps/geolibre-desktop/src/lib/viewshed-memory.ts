export const VIEWSHED_MEMORY_BUDGET_BYTES = 128 * 1024 * 1024;
export const VIEWSHED_PARSER_RESERVE_BYTES = 8 * 1024 * 1024;
export const VIEWSHED_RUNTIME_RESERVE_BYTES = 16 * 1024 * 1024;
export const VIEWSHED_ANALYSIS_OBJECT_RESERVE_BYTES = 7 * 1024 * 1024;
export const VIEWSHED_IPC_RESULT_RESERVE_BYTES = 10 * 1024 * 1024;
export const VIEWSHED_IPC_CLONE_RESERVE_BYTES = 10 * 1024 * 1024;

function checkedBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("VIEWSHED_LIMIT_EXCEEDED");
  return value;
}

/** Executable feature-allocation ledger; reservation always precedes the covered allocation. */
export class ViewshedMemoryLedger {
  readonly #capacity: number;
  readonly #reservations = new Map<string, number>();
  #used = 0;

  constructor(capacity = VIEWSHED_MEMORY_BUDGET_BYTES) {
    this.#capacity = checkedBytes(capacity);
  }

  reserve(name: string, bytes: number): void {
    const amount = checkedBytes(bytes);
    const existing = this.#reservations.get(name);
    if (existing !== undefined) {
      if (existing !== amount) throw new Error("VIEWSHED_INTERNAL");
      return;
    }
    const next = this.#used + amount;
    if (!Number.isSafeInteger(next) || next > this.#capacity) {
      throw new Error("VIEWSHED_LIMIT_EXCEEDED");
    }
    this.#reservations.set(name, amount);
    this.#used = next;
  }

  resize(name: string, bytes: number): void {
    const amount = checkedBytes(bytes);
    const existing = this.#reservations.get(name);
    if (existing === undefined || amount > existing)
      throw new Error("VIEWSHED_INTERNAL");
    this.#reservations.set(name, amount);
    this.#used -= existing - amount;
  }

  release(name: string): void {
    const existing = this.#reservations.get(name);
    if (existing === undefined) throw new Error("VIEWSHED_INTERNAL");
    this.#reservations.delete(name);
    this.#used -= existing;
  }

  reset(): void {
    this.#reservations.clear();
    this.#used = 0;
  }

  get usedBytes(): number {
    return this.#used;
  }
}

export class AsyncEventStream<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #error: unknown;

  push(value: T): void {
    if (this.#closed) {
      throw new Error("cannot push to a closed event stream");
    }
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#values.push(value);
    } else {
      waiter.resolve({ done: false, value });
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#error = error;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.#values.shift();
        if (value !== undefined) {
          return { done: false, value };
        }
        if (this.#closed) {
          if (this.#error !== undefined) {
            throw this.#error;
          }
          return { done: true, value: undefined };
        }
        return await new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      }
    };
  }
}

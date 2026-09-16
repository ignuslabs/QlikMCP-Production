/** A store may be local/synchronous or backed by an asynchronous AWS service. */
export type Awaitable<T> = T | Promise<T>;

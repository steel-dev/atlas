import type {
  ResearchEvent,
  ResearchResult,
  ResearchStream,
} from "./research.js";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Subscriber {
  queue: ResearchEvent[];
  resolveNext: ((result: IteratorResult<ResearchEvent>) => void) | null;
  rejectNext: ((error: unknown) => void) | null;
  predicate: ((event: ResearchEvent) => boolean) | null;
}

export interface ResearchStreamController {
  emit(event: ResearchEvent): void;
  resolve(result: ResearchResult): void;
  reject(error: unknown): void;
  close(): void;
  build(controls: { abort(): void; stop(): void }): ResearchStream;
}

export function createResearchStreamController(): ResearchStreamController {
  const subscribers = new Set<Subscriber>();
  const done = createDeferred<ResearchResult>();
  done.promise.catch(() => {});
  let closed = false;
  let failure: { error: unknown } | null = null;

  const emit = (event: ResearchEvent): void => {
    if (closed) return;
    for (const sub of subscribers) {
      if (sub.predicate && !sub.predicate(event)) continue;
      if (sub.resolveNext) {
        const resolveNext = sub.resolveNext;
        sub.resolveNext = null;
        sub.rejectNext = null;
        resolveNext({ value: event, done: false });
      } else {
        sub.queue.push(event);
      }
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const sub of subscribers) {
      if (sub.resolveNext) {
        const resolveNext = sub.resolveNext;
        sub.resolveNext = null;
        sub.rejectNext = null;
        resolveNext({ value: undefined, done: true });
      }
    }
  };

  const resolve = (result: ResearchResult): void => {
    done.resolve(result);
  };

  const reject = (error: unknown): void => {
    done.reject(error);
    if (closed) return;
    failure = { error };
    closed = true;
    for (const sub of subscribers) {
      if (sub.rejectNext) {
        const rejectNext = sub.rejectNext;
        sub.resolveNext = null;
        sub.rejectNext = null;
        rejectNext(error);
      }
    }
  };

  const subscribe = (
    predicate?: (event: ResearchEvent) => boolean,
  ): AsyncIterator<ResearchEvent> => {
    const sub: Subscriber = {
      queue: [],
      resolveNext: null,
      rejectNext: null,
      predicate: predicate ?? null,
    };
    subscribers.add(sub);
    return {
      next(): Promise<IteratorResult<ResearchEvent>> {
        if (sub.queue.length > 0) {
          return Promise.resolve({
            value: sub.queue.shift() as ResearchEvent,
            done: false,
          });
        }
        if (failure) {
          subscribers.delete(sub);
          return Promise.reject(failure.error);
        }
        if (closed) {
          subscribers.delete(sub);
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<ResearchEvent>>((res, rej) => {
          sub.resolveNext = res;
          sub.rejectNext = rej;
        });
      },
      return(): Promise<IteratorResult<ResearchEvent>> {
        subscribers.delete(sub);
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  };

  const fullStream: AsyncIterable<ResearchEvent> = {
    [Symbol.asyncIterator]: () => subscribe(),
  };

  const textStream: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      const iterator = subscribe((event) => event.type === "report_delta");
      return {
        async next(): Promise<IteratorResult<string>> {
          const result = await iterator.next();
          if (result.done || result.value.type !== "report_delta") {
            return { value: undefined, done: true };
          }
          return { value: result.value.text, done: false };
        },
        async return(): Promise<IteratorResult<string>> {
          await iterator.return?.();
          return { value: undefined, done: true };
        },
      };
    },
  };

  const events: AsyncIterable<ResearchEvent> = {
    [Symbol.asyncIterator]: () =>
      subscribe(
        (event) =>
          event.type !== "report_delta" && event.type !== "report_boundary",
      ),
  };

  const build = (controls: {
    abort(): void;
    stop(): void;
  }): ResearchStream => ({
    fullStream,
    textStream,
    events,
    result: done.promise,
    get markdown(): Promise<string> {
      return done.promise.then((result) => result.markdown);
    },
    get citedSources() {
      return done.promise.then((result) => result.citedSources);
    },
    get citationsNotFetched() {
      return done.promise.then((result) => result.citationsNotFetched);
    },
    get usage() {
      return done.promise.then((result) => result.usage);
    },
    abort: controls.abort,
    stop: controls.stop,
  });

  return { emit, resolve, reject, close, build };
}

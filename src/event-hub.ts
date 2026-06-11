import type { ResearchEvent } from "./events.js";

interface EventSubscriber {
  queue: ResearchEvent[];
  resolveNext: ((result: IteratorResult<ResearchEvent>) => void) | null;
  rejectNext: ((error: unknown) => void) | null;
}

export class EventHub {
  private readonly subscribers = new Set<EventSubscriber>();
  private readonly history: ResearchEvent[] = [];
  private closed = false;
  private failure: unknown = null;

  emit(event: ResearchEvent): void {
    if (this.closed) return;
    this.history.push(event);
    for (const sub of this.subscribers) {
      if (sub.resolveNext) {
        const resolve = sub.resolveNext;
        sub.resolveNext = null;
        sub.rejectNext = null;
        resolve({ value: event, done: false });
      } else {
        sub.queue.push(event);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subscribers) {
      sub.resolveNext?.({ value: undefined, done: true });
      sub.resolveNext = null;
      sub.rejectNext = null;
    }
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    for (const sub of this.subscribers) {
      sub.rejectNext?.(error);
      sub.resolveNext = null;
      sub.rejectNext = null;
    }
  }

  iterable(): AsyncIterable<ResearchEvent> {
    const subscribers = this.subscribers;
    const hub = this;
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<ResearchEvent> => {
        const sub: EventSubscriber = {
          queue: [...hub.history],
          resolveNext: null,
          rejectNext: null,
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
            if (hub.failure) {
              subscribers.delete(sub);
              return Promise.reject(hub.failure);
            }
            if (hub.closed) {
              subscribers.delete(sub);
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve, reject) => {
              sub.resolveNext = resolve;
              sub.rejectNext = reject;
            });
          },
          return(): Promise<IteratorResult<ResearchEvent>> {
            subscribers.delete(sub);
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }
}

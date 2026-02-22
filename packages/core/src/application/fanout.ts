import type { StateUpdatedNotification } from "../domain/events";
import type { FanoutPort } from "../ports";

interface Sink<T> {
  push(value: T): void;
  close(): void;
  iterable: AsyncIterable<T>;
}

function createSink<T>(): Sink<T> {
  const queue: T[] = [];
  const waiters: Array<(value: IteratorResult<T>) => void> = [];
  let closed = false;
  const push = (value: T) => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    queue.push(value);
  };
  const close = () => {
    closed = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter?.({ value: undefined as never, done: true });
    }
  };
  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (queue.length > 0) {
            return { value: queue.shift() as T, done: false };
          }
          if (closed) {
            return { value: undefined as never, done: true };
          }
          return new Promise<IteratorResult<T>>((resolve) => {
            waiters.push(resolve);
          });
        },
      };
    },
  };
  return { push, close, iterable };
}

export class EffectFanout implements FanoutPort {
  private readonly sinks = new Set<Sink<StateUpdatedNotification>>();

  async publish(notification: StateUpdatedNotification): Promise<void> {
    for (const sink of this.sinks) {
      sink.push(notification);
    }
  }

  async subscribe(): Promise<AsyncIterable<StateUpdatedNotification>> {
    const sink = createSink<StateUpdatedNotification>();
    this.sinks.add(sink);
    return sink.iterable;
  }
}

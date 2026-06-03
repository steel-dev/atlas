import type { ResearchCtx } from "./runtime.js";

export const LEAD_ADDRESS = "lead";
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
export const MAX_WAIT_TIMEOUT_MS = 600_000;
const MESSAGE_MAX_CHARS = 8_000;
const MESSAGE_TRUNCATE_MARKER = "\n... [message truncated]";

export interface MailboxMessage {
  from: string;
  content: string;
}

export interface SendOutcome {
  delivered_to: string;
  note?: string;
}

export interface ReceiveOutcome {
  messages: MailboxMessage[];
  timed_out?: boolean;
  no_more_senders?: boolean;
  note?: string;
}

export interface MessagingScope {
  readonly address: string;
  send(to: string, content: string): SendOutcome | string;
  receive(opts?: { timeoutMs?: number }): Promise<ReceiveOutcome>;
  drain(): MailboxMessage[];
}

export interface MessageBroker {
  register(address: string): void;
  mailbox(address: string, ctx: ResearchCtx): MessagingScope;
  close(address: string): void;
  wake(addresses: string[], note: string): void;
}

interface Waiter {
  deliver(outcome: ReceiveOutcome): void;
  fail(err: unknown): void;
}

interface Mailbox {
  queue: MailboxMessage[];
  waiter?: Waiter;
  open: boolean;
}

function truncateMessage(content: string): string {
  if (content.length <= MESSAGE_MAX_CHARS) return content;
  return content.slice(0, MESSAGE_MAX_CHARS) + MESSAGE_TRUNCATE_MARKER;
}

export function createMessageBroker(): MessageBroker {
  const boxes = new Map<string, Mailbox>();

  const knownAddresses = (): string =>
    [...boxes.keys()].join(", ") || "(none)";

  const noMoreSenders = (address: string): boolean => {
    for (const [name, box] of boxes) {
      if (name !== address && box.open) return false;
    }
    return true;
  };

  const wakeIfNoMoreSenders = (address: string, box: Mailbox): void => {
    if (!box.waiter) return;
    if (box.queue.length > 0 || !noMoreSenders(address)) return;
    const waiter = box.waiter;
    waiter.deliver({ messages: [], no_more_senders: true });
  };

  function register(address: string): void {
    if (boxes.has(address)) return;
    boxes.set(address, { queue: [], open: true });
  }

  function close(address: string): void {
    const box = boxes.get(address);
    if (!box) return;
    box.open = false;
    if (box.waiter) {
      box.waiter.deliver({
        messages: box.queue.splice(0),
        note: "mailbox closed",
      });
    }
    for (const [name, other] of boxes) {
      if (name === address || !other.open) continue;
      wakeIfNoMoreSenders(name, other);
    }
  }

  function wake(addresses: string[], note: string): void {
    for (const address of addresses) {
      const box = boxes.get(address);
      if (!box || !box.open || !box.waiter) continue;
      box.waiter.deliver({ messages: box.queue.splice(0), note });
    }
  }

  function mailbox(address: string, ctx: ResearchCtx): MessagingScope {
    register(address);

    const send = (to: string, content: string): SendOutcome | string => {
      if (to === address) {
        return "Error: cannot send a message to yourself.";
      }
      const box = boxes.get(to);
      if (!box) {
        return `Error: unknown recipient '${to}'. Known recipients: ${knownAddresses()}.`;
      }
      if (!box.open) {
        return {
          delivered_to: to,
          note: "recipient has finished; the message will not be read",
        };
      }
      box.queue.push({ from: address, content: truncateMessage(content) });
      if (box.waiter) {
        box.waiter.deliver({ messages: box.queue.splice(0) });
      }
      return { delivered_to: to };
    };

    const receive = async (opts?: {
      timeoutMs?: number;
    }): Promise<ReceiveOutcome> => {
      const box = boxes.get(address);
      if (!box) return { messages: [], note: "mailbox closed" };
      ctx.deps.signal?.throwIfAborted();
      if (ctx.deps.stopSignal?.aborted) {
        return { messages: box.queue.splice(0), note: "stop requested" };
      }
      if (box.queue.length > 0) {
        return { messages: box.queue.splice(0) };
      }
      if (box.waiter) {
        return {
          messages: [],
          note: "another wait_for_message is already in progress",
        };
      }
      if (noMoreSenders(address)) {
        return { messages: [], no_more_senders: true };
      }

      const requested = Math.min(
        opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
        MAX_WAIT_TIMEOUT_MS,
      );
      let effective = requested;
      const deadlineAt = ctx.scope.deadlineAt;
      const reserveMs = ctx.scope.synthesisReserveMs;
      if (deadlineAt !== undefined && reserveMs !== undefined) {
        effective = Math.min(effective, deadlineAt - reserveMs - Date.now());
      }
      if (effective <= 0) {
        return {
          messages: [],
          timed_out: true,
          note: "not enough time remains to wait; finish and write your findings",
        };
      }

      return await new Promise<ReceiveOutcome>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const hardSignal = ctx.deps.signal;
        const stopSignal = ctx.deps.stopSignal;

        const cleanup = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          hardSignal?.removeEventListener("abort", onHardAbort);
          stopSignal?.removeEventListener("abort", onStop);
          if (box.waiter === waiter) box.waiter = undefined;
        };
        const deliver = (outcome: ReceiveOutcome): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(outcome);
        };
        const fail = (err: unknown): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };
        const onHardAbort = (): void => {
          fail(
            hardSignal?.reason instanceof Error
              ? hardSignal.reason
              : new Error("research aborted"),
          );
        };
        const onStop = (): void => {
          deliver({ messages: box.queue.splice(0), note: "stop requested" });
        };
        const waiter: Waiter = { deliver, fail };

        timer = setTimeout(() => {
          deliver({
            messages: box.queue.splice(0),
            timed_out: true,
            note: `no messages arrived within ${effective}ms`,
          });
        }, effective);
        hardSignal?.addEventListener("abort", onHardAbort, { once: true });
        stopSignal?.addEventListener("abort", onStop, { once: true });
        box.waiter = waiter;
      });
    };

    const drain = (): MailboxMessage[] => {
      const box = boxes.get(address);
      if (!box) return [];
      return box.queue.splice(0);
    };

    return { address, send, receive, drain };
  }

  return { register, mailbox, close, wake };
}

export const NO_MESSAGING: MessagingScope = {
  address: "none",
  send: () =>
    "Error: messaging is not available right now. Continue with the evidence tools.",
  receive: async () => ({
    messages: [],
    note: "messaging is not available right now",
  }),
  drain: () => [],
};

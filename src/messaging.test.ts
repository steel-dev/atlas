import { describe, expect, it } from "vitest";
import {
  createMessageBroker,
  NO_MESSAGING,
  type SendOutcome,
} from "./messaging.js";
import type { ResearchCtx } from "./runtime.js";

function fakeCtx(opts?: {
  signal?: AbortSignal;
  stopSignal?: AbortSignal;
  deadlineAt?: number;
  synthesisReserveMs?: number;
}): ResearchCtx {
  return {
    deps: { signal: opts?.signal, stopSignal: opts?.stopSignal },
    scope: {
      deadlineAt: opts?.deadlineAt,
      synthesisReserveMs: opts?.synthesisReserveMs,
    },
  } as unknown as ResearchCtx;
}

describe("messaging broker", () => {
  it("delivers queued messages in arrival order", async () => {
    const broker = createMessageBroker();
    const lead = broker.mailbox("lead", fakeCtx());
    const agent = broker.mailbox("agent_1", fakeCtx());

    agent.send("lead", "first");
    agent.send("lead", "second");

    const outcome = await lead.receive();
    expect(outcome.messages).toEqual([
      { from: "agent_1", content: "first" },
      { from: "agent_1", content: "second" },
    ]);

    const empty = lead.drain();
    expect(empty).toEqual([]);
  });

  it("wakes a parked receive when a message arrives", async () => {
    const broker = createMessageBroker();
    const lead = broker.mailbox("lead", fakeCtx());
    const agent = broker.mailbox("agent_1", fakeCtx());

    const pending = lead.receive({ timeoutMs: 5_000 });
    const sent = agent.send("lead", "hello") as SendOutcome;
    expect(sent.delivered_to).toBe("lead");

    const outcome = await pending;
    expect(outcome.messages).toEqual([{ from: "agent_1", content: "hello" }]);
    expect(outcome.timed_out).toBeUndefined();
  });

  it("rejects a second concurrent receive on the same mailbox", async () => {
    const broker = createMessageBroker();
    const lead = broker.mailbox("lead", fakeCtx());
    const agent = broker.mailbox("agent_1", fakeCtx());

    const first = lead.receive({ timeoutMs: 5_000 });
    const second = await lead.receive({ timeoutMs: 5_000 });
    expect(second.messages).toEqual([]);
    expect(second.note).toContain("already in progress");

    agent.send("lead", "ping");
    const outcome = await first;
    expect(outcome.messages).toHaveLength(1);
  });

  it("times out a parked receive", async () => {
    const broker = createMessageBroker();
    const lead = broker.mailbox("lead", fakeCtx());
    broker.register("agent_1");

    const outcome = await lead.receive({ timeoutMs: 10 });
    expect(outcome.timed_out).toBe(true);
    expect(outcome.messages).toEqual([]);
  });

  it("returns no_more_senders immediately when nothing can send", async () => {
    const broker = createMessageBroker();
    const lead = broker.mailbox("lead", fakeCtx());

    const outcome = await lead.receive({ timeoutMs: 5_000 });
    expect(outcome.no_more_senders).toBe(true);
  });

  it("wakes a parked lead with no_more_senders when the last sender closes", async () => {
    const broker = createMessageBroker();
    const lead = broker.mailbox("lead", fakeCtx());
    broker.register("agent_1");

    const pending = lead.receive({ timeoutMs: 5_000 });
    broker.close("agent_1");

    const outcome = await pending;
    expect(outcome.no_more_senders).toBe(true);
    expect(outcome.messages).toEqual([]);
  });

  it("delivers a queued message before reporting no_more_senders", async () => {
    const broker = createMessageBroker();
    const lead = broker.mailbox("lead", fakeCtx());
    const agent = broker.mailbox("agent_1", fakeCtx());

    agent.send("lead", "parting gift");
    broker.close("agent_1");

    const first = await lead.receive({ timeoutMs: 5_000 });
    expect(first.messages).toEqual([
      { from: "agent_1", content: "parting gift" },
    ]);

    const second = await lead.receive({ timeoutMs: 5_000 });
    expect(second.no_more_senders).toBe(true);
  });

  it("rejects a parked receive on hard abort", async () => {
    const broker = createMessageBroker();
    const controller = new AbortController();
    const lead = broker.mailbox("lead", fakeCtx({ signal: controller.signal }));
    broker.register("agent_1");

    const pending = lead.receive({ timeoutMs: 5_000 });
    controller.abort(new Error("hard abort"));
    await expect(pending).rejects.toThrow("hard abort");
  });

  it("throws immediately when the run is already aborted", async () => {
    const broker = createMessageBroker();
    const controller = new AbortController();
    controller.abort();
    const lead = broker.mailbox("lead", fakeCtx({ signal: controller.signal }));
    broker.register("agent_1");

    await expect(lead.receive({ timeoutMs: 5_000 })).rejects.toThrow();
  });

  it("resolves a parked receive with a note on soft stop", async () => {
    const broker = createMessageBroker();
    const controller = new AbortController();
    const lead = broker.mailbox(
      "lead",
      fakeCtx({ stopSignal: controller.signal }),
    );
    broker.register("agent_1");

    const pending = lead.receive({ timeoutMs: 5_000 });
    controller.abort();
    const outcome = await pending;
    expect(outcome.note).toBe("stop requested");
  });

  it("clamps the wait to the synthesis reserve", async () => {
    const broker = createMessageBroker();
    const lead = broker.mailbox(
      "lead",
      fakeCtx({ deadlineAt: Date.now() + 1_000, synthesisReserveMs: 5_000 }),
    );
    broker.register("agent_1");

    const outcome = await lead.receive({ timeoutMs: 60_000 });
    expect(outcome.timed_out).toBe(true);
    expect(outcome.note).toContain("not enough time remains");
  });

  it("broadcastCollecting wakes parked sub-agents but not the lead", async () => {
    const broker = createMessageBroker();
    const lead = broker.mailbox("lead", fakeCtx());
    const agent = broker.mailbox("agent_1", fakeCtx());

    const agentPending = agent.receive({ timeoutMs: 5_000 });
    const leadPending = lead.receive({ timeoutMs: 50 });
    broker.broadcastCollecting("the lead is collecting findings now");

    const agentOutcome = await agentPending;
    expect(agentOutcome.note).toBe("the lead is collecting findings now");

    const leadOutcome = await leadPending;
    expect(leadOutcome.timed_out).toBe(true);
  });

  it("validates recipients", () => {
    const broker = createMessageBroker();
    const lead = broker.mailbox("lead", fakeCtx());
    broker.mailbox("agent_1", fakeCtx());

    expect(lead.send("lead", "hi")).toBe(
      "Error: cannot send a message to yourself.",
    );
    expect(lead.send("agent_9", "hi")).toContain(
      "Error: unknown recipient 'agent_9'",
    );

    broker.close("agent_1");
    const closed = lead.send("agent_1", "too late") as SendOutcome;
    expect(closed.note).toContain("recipient has finished");
  });

  it("truncates oversized messages", async () => {
    const broker = createMessageBroker();
    const lead = broker.mailbox("lead", fakeCtx());
    const agent = broker.mailbox("agent_1", fakeCtx());

    agent.send("lead", "x".repeat(9_000));
    const outcome = await lead.receive();
    expect(outcome.messages[0]?.content.length).toBeLessThan(8_100);
    expect(outcome.messages[0]?.content.endsWith("[message truncated]")).toBe(
      true,
    );
  });

  it("NO_MESSAGING stub refuses politely", async () => {
    expect(NO_MESSAGING.send("lead", "hi")).toContain(
      "Error: messaging is not available",
    );
    const outcome = await NO_MESSAGING.receive();
    expect(outcome.messages).toEqual([]);
    expect(NO_MESSAGING.drain()).toEqual([]);
  });
});

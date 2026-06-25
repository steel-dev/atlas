import { describe, expect, it } from "vitest";
import { safeLookup } from "./safe-dispatcher.js";

function runLookup(
  policy: Parameters<typeof safeLookup>[0],
  hostname: string,
  all: boolean,
): Promise<{
  err: (NodeJS.ErrnoException & { code?: string }) | null;
  address: string | Array<{ address: string; family: number }>;
  family?: number;
}> {
  return new Promise((resolve) => {
    safeLookup(policy)(hostname, { all }, (err, address, family) => {
      resolve({ err: err as never, address, family });
    });
  });
}

describe("safeLookup", () => {
  it("blocks hostnames that resolve to a private/reserved address", async () => {
    const result = await runLookup({}, "127.0.0.1", false);
    expect(result.err?.code).toBe("ESSRFBLOCKED");
  });

  it("blocks the cloud metadata address", async () => {
    const result = await runLookup({}, "169.254.169.254", false);
    expect(result.err?.code).toBe("ESSRFBLOCKED");
  });

  it("allows public addresses and returns them", async () => {
    const result = await runLookup({}, "8.8.8.8", false);
    expect(result.err).toBeNull();
    expect(result.address).toBe("8.8.8.8");
    expect(result.family).toBe(4);
  });

  it("returns an array when undici asks for all addresses", async () => {
    const result = await runLookup({}, "8.8.8.8", true);
    expect(result.err).toBeNull();
    expect(Array.isArray(result.address)).toBe(true);
    expect((result.address as Array<{ address: string }>)[0].address).toBe(
      "8.8.8.8",
    );
  });

  it("permits private addresses when allowPrivateNetworks is set", async () => {
    const result = await runLookup(
      { allowPrivateNetworks: true },
      "127.0.0.1",
      false,
    );
    expect(result.err).toBeNull();
    expect(result.address).toBe("127.0.0.1");
  });
});

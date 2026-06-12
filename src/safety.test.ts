import { describe, expect, it } from "vitest";
import {
  guardRedirect,
  guardUrl,
  isPrivateAddress,
  quarantine,
} from "./safety.js";

describe("isPrivateAddress", () => {
  it("flags private and loopback ranges", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("169.254.10.10")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
  });

  it("allows public addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });

  it("flags IPv4-mapped IPv6 in both hex and dotted forms", () => {
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:a9fe:a9fe")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateAddress("::ffff:808:808")).toBe(false);
  });

  it("flags NAT64 and 6to4 addresses wrapping private IPv4", () => {
    expect(isPrivateAddress("64:ff9b::7f00:1")).toBe(true);
    expect(isPrivateAddress("64:ff9b::808:808")).toBe(false);
    expect(isPrivateAddress("2002:7f00:1::")).toBe(true);
    expect(isPrivateAddress("2002:808:808::")).toBe(false);
  });
});

describe("guardUrl", () => {
  const baseOpts = () => ({
    policy: {},
    seenDomains: new Set<string>(),
  });

  it("rejects non-http schemes", async () => {
    const result = await guardUrl("file:///etc/passwd", baseOpts());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("scheme");
  });

  it("rejects embedded credentials", async () => {
    const result = await guardUrl("https://user:pass@example.com/", baseOpts());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("ssrf");
  });

  it("rejects literal private addresses", async () => {
    const result = await guardUrl("http://127.0.0.1:8080/admin", baseOpts());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("ssrf");
  });

  it("flags high-entropy query strings on first-seen domains", async () => {
    const noise = Array.from({ length: 90 }, (_, i) =>
      String.fromCharCode(33 + ((i * 17) % 90)),
    ).join("");
    const result = await guardUrl(
      `http://203.0.113.7/?x=${encodeURIComponent(noise)}`,
      baseOpts(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("url-entropy");
  });

  it("allows flagged urls when the policy opts in", async () => {
    const noise = Array.from({ length: 90 }, (_, i) =>
      String.fromCharCode(33 + ((i * 17) % 90)),
    ).join("");
    const result = await guardUrl(
      `http://203.0.113.7/?x=${encodeURIComponent(noise)}`,
      { policy: { allowFlaggedUrls: true }, seenDomains: new Set() },
    );
    expect(result.ok).toBe(true);
  });
});

describe("quarantine", () => {
  it("wraps content in provenance-tagged markers", () => {
    const wrapped = quarantine("page text", {
      sourceId: "source_1",
      url: "https://example.com",
    });
    expect(wrapped).toContain("<<<untrusted-source source_1 https://example.com>>>");
    expect(wrapped).toContain("page text");
    expect(wrapped).toContain("<<<end-untrusted-source>>>");
  });
});

describe("guardRedirect", () => {
  it("blocks redirects to private addresses", async () => {
    const result = await guardRedirect("http://127.0.0.1/admin", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("ssrf");
  });

  it("blocks alternate encodings of private addresses", async () => {
    for (const url of [
      "http://[::ffff:7f00:1]/admin",
      "http://0x7f000001/admin",
      "http://2130706433/admin",
      "http://127.1/admin",
      "http://0177.0.0.1/admin",
    ]) {
      const result = await guardRedirect(url, {});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.kind).toBe("ssrf");
    }
  });

  it("blocks non-http schemes", async () => {
    const result = await guardRedirect("file:///etc/passwd", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("scheme");
  });

  it("does not flag high-entropy queries the way guardUrl does", async () => {
    const noise = Array.from({ length: 90 }, (_, i) =>
      String.fromCharCode(33 + ((i * 17) % 90)),
    ).join("");
    const result = await guardRedirect(
      `http://203.0.113.7/?x=${encodeURIComponent(noise)}`,
      {},
    );
    expect(result.ok).toBe(true);
  });
});

import { lookup as dnsLookup } from "node:dns";
import { Agent } from "undici";
import { isPrivateAddress, type SafetyPolicy } from "./safety.js";

export type SafeDispatcher = Agent;

type SafeLookupOptions = {
  all?: boolean;
  family?: number;
  hints?: number;
  verbatim?: boolean;
};

type SafeLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

export function safeLookup(policy: SafetyPolicy) {
  return (
    hostname: string,
    options: SafeLookupOptions,
    callback: SafeLookupCallback,
  ): void => {
    dnsLookup(
      hostname,
      { ...options, all: true as const },
      (err, addresses) => {
        if (err) {
          callback(err, "", 0);
          return;
        }
        if (!policy.allowPrivateNetworks) {
          const blocked = addresses.find((entry) =>
            isPrivateAddress(entry.address),
          );
          if (blocked) {
            callback(
              Object.assign(
                new Error(
                  `SSRF blocked: ${hostname} resolves to private address ${blocked.address}`,
                ),
                { code: "ESSRFBLOCKED" },
              ),
              "",
              0,
            );
            return;
          }
        }
        if (options.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      },
    );
  };
}

export function createSafeDispatcher(policy: SafetyPolicy): SafeDispatcher {
  const options = {
    connect: { lookup: safeLookup(policy) },
  } as unknown as ConstructorParameters<typeof Agent>[0];
  return new Agent(options);
}

import { ulid } from "ulidx";

export function newJobId(): string {
  return ulid().toLowerCase();
}

export function newRequestId(): string {
  return `req_${ulid().toLowerCase()}`;
}

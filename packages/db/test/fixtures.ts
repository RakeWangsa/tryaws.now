import { randomBytes } from "node:crypto";

export function uniqueSuffix(): string {
  return randomBytes(4).toString("hex");
}

import { parseTopUpAmount } from "@tc/core";
import { describe, expect, it } from "vitest";
import { previewAmount } from "./amount-preview.ts";

const RANGE = { minMinor: 10000n, maxMinor: 5000000n };

// Every text here is read by the preview exactly as the server reads it.
const TEXTS = [
  "1500",
  "১৫০০",
  "1,500",
  "1,50,000",
  " 500 ",
  "5 00",
  "5 00",
  "100",
  "99",
  "50000",
  "50001",
  "500.00",
  "500.5",
  "-500",
  "+500",
  "৳500",
  "1e3",
  "0x10",
  "５００",
  "٥٠٠",
  "500\n600",
  "1234567890",
  "123456789",
  "",
  "   ",
  ",",
  "abc",
  "0",
  "000",
  "১২৩abc",
];

describe("previewAmount agrees with parseTopUpAmount", () => {
  for (const text of TEXTS) {
    it(`${JSON.stringify(text)}`, () => {
      const server = parseTopUpAmount(text, RANGE);
      expect(previewAmount(text, RANGE)).toBe(server.ok ? server.amountMinor : null);
    });
  }
});

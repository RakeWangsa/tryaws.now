import { describe, expect, it } from "vitest";
import { amountInWords } from "./index";

describe("amountInWords", () => {
  it("english, Indian grouping, taka and paisa", () => {
    expect(amountInWords(0n, "en")).toBe("Zero Taka only");
    expect(amountInWords(10550n, "en")).toBe("One Hundred Five Taka and Fifty Paisa only");
    expect(amountInWords(100n, "en")).toBe("One Taka only");
    expect(amountInWords(123456789n, "en")).toBe(
      "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Taka and Eighty Nine Paisa only",
    );
    expect(amountInWords(10_000_000_00n, "en")).toBe("One Crore Taka only");
    expect(amountInWords(5n, "en")).toBe("Five Paisa only");
  });
  it("bengali words", () => {
    expect(amountInWords(0n, "bn")).toBe("শূন্য টাকা মাত্র");
    expect(amountInWords(10550n, "bn")).toBe("একশত পাঁচ টাকা ও পঞ্চাশ পয়সা মাত্র");
    expect(amountInWords(2100n, "bn")).toBe("একুশ টাকা মাত্র");
    expect(amountInWords(10_000_000n, "bn")).toBe("এক লক্ষ টাকা মাত্র");
    expect(amountInWords(10_000_000_00n, "bn")).toBe("এক কোটি টাকা মাত্র");
  });
  it("refuses a negative or non-bigint amount", () => {
    expect(() => amountInWords(-1n, "en")).toThrow();
    expect(() => amountInWords(1 as unknown as bigint, "en")).toThrow();
  });
});

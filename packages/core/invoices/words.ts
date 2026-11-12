// The amount in words for a tax invoice (Mushak 6.3). Integer paisa only (R4): no float. Indian grouping
// (lakh, crore) as Bangladesh writes it, in English and in Bengali.
import type { Locale, Minor } from "../types";
import { InvoiceError } from "./base";

const EN_ONES = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const EN_TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

function enBelow100(n: number): string {
  if (n < 20) return EN_ONES[n] ?? "";
  const tens = EN_TENS[Math.floor(n / 10)] ?? "";
  return n % 10 === 0 ? tens : `${tens} ${EN_ONES[n % 10]}`;
}
function enBelow1000(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${EN_ONES[h]} Hundred`);
  if (rest > 0) parts.push(enBelow100(rest));
  return parts.join(" ");
}

// Bengali 0 to 99: the numbers are irregular, so each has its word.
const BN_100 = [
  "শূন্য",
  "এক",
  "দুই",
  "তিন",
  "চার",
  "পাঁচ",
  "ছয়",
  "সাত",
  "আট",
  "নয়",
  "দশ",
  "এগারো",
  "বারো",
  "তেরো",
  "চৌদ্দ",
  "পনেরো",
  "ষোলো",
  "সতেরো",
  "আঠারো",
  "ঊনিশ",
  "বিশ",
  "একুশ",
  "বাইশ",
  "তেইশ",
  "চব্বিশ",
  "পঁচিশ",
  "ছাব্বিশ",
  "সাতাশ",
  "আটাশ",
  "ঊনত্রিশ",
  "ত্রিশ",
  "একত্রিশ",
  "বত্রিশ",
  "তেত্রিশ",
  "চৌত্রিশ",
  "পঁয়ত্রিশ",
  "ছত্রিশ",
  "সাঁইত্রিশ",
  "আটত্রিশ",
  "ঊনচল্লিশ",
  "চল্লিশ",
  "একচল্লিশ",
  "বিয়াল্লিশ",
  "তেতাল্লিশ",
  "চুয়াল্লিশ",
  "পঁয়তাল্লিশ",
  "ছেচল্লিশ",
  "সাতচল্লিশ",
  "আটচল্লিশ",
  "ঊনপঞ্চাশ",
  "পঞ্চাশ",
  "একান্ন",
  "বায়ান্ন",
  "তিপ্পান্ন",
  "চুয়ান্ন",
  "পঞ্চান্ন",
  "ছাপ্পান্ন",
  "সাতান্ন",
  "আটান্ন",
  "ঊনষাট",
  "ষাট",
  "একষট্টি",
  "বাষট্টি",
  "তেষট্টি",
  "চৌষট্টি",
  "পঁয়ষট্টি",
  "ছেষট্টি",
  "সাতষট্টি",
  "আটষট্টি",
  "ঊনসত্তর",
  "সত্তর",
  "একাত্তর",
  "বাহাত্তর",
  "তিয়াত্তর",
  "চুয়াত্তর",
  "পঁচাত্তর",
  "ছিয়াত্তর",
  "সাতাত্তর",
  "আটাত্তর",
  "ঊনআশি",
  "আশি",
  "একাশি",
  "বিরাশি",
  "তিরাশি",
  "চুরাশি",
  "পঁচাশি",
  "ছিয়াশি",
  "সাতাশি",
  "আটাশি",
  "ঊননব্বই",
  "নব্বই",
  "একানব্বই",
  "বিরানব্বই",
  "তিরানব্বই",
  "চুরানব্বই",
  "পঁচানব্বই",
  "ছিয়ানব্বই",
  "সাতানব্বই",
  "আটানব্বই",
  "নিরানব্বই",
];
function bnBelow1000(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h > 0) parts.push(`${BN_100[h]}শত`);
  if (rest > 0) parts.push(BN_100[rest] ?? "");
  return parts.join(" ");
}

type Unit = { size: bigint; en: string; bn: string };
const UNITS: readonly Unit[] = [
  { size: 10_000_000n, en: "Crore", bn: "কোটি" },
  { size: 100_000n, en: "Lakh", bn: "লক্ষ" },
  { size: 1_000n, en: "Thousand", bn: "হাজার" },
];

function words(n: bigint, locale: Locale): string {
  if (n === 0n) return locale === "bn" ? "শূন্য" : "Zero";
  const below = locale === "bn" ? bnBelow1000 : enBelow1000;
  const small = locale === "bn" ? (x: number) => BN_100[x] ?? "" : enBelow100;
  const parts: string[] = [];
  let rest = n;
  for (const unit of UNITS) {
    const count = rest / unit.size;
    rest %= unit.size;
    if (count === 0n) continue;
    // The crore count itself may be above 99: it is spelled recursively.
    const head = unit.size === 10_000_000n ? words(count, locale) : small(Number(count));
    parts.push(`${head} ${locale === "bn" ? unit.bn : unit.en}`);
  }
  if (rest > 0n) parts.push(below(Number(rest)));
  return parts.join(" ");
}

export function amountInWords(amount: Minor, locale: Locale): string {
  if (typeof amount !== "bigint" || amount < 0n) throw new InvoiceError("invalid_amount");
  const taka = amount / 100n;
  const paisa = Number(amount % 100n);
  const bn = locale === "bn";
  const parts: string[] = [];
  if (taka > 0n || paisa === 0) parts.push(`${words(taka, locale)} ${bn ? "টাকা" : "Taka"}`);
  if (paisa > 0) {
    const p = `${bn ? BN_100[paisa] : enBelow100(paisa)} ${bn ? "পয়সা" : "Paisa"}`;
    parts.push(taka > 0n ? `${bn ? "ও" : "and"} ${p}` : p);
  }
  return `${parts.join(" ")} ${bn ? "মাত্র" : "only"}`;
}

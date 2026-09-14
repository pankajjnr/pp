import { clsx } from "clsx";
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// Formats a raw numeric string using the Indian digit-grouping convention
// (last 3 digits, then groups of 2): "1234567.5" -> "12,34,567.5"
export function formatIndianNumber(value) {
  if (value === "" || value === null || value === undefined) return "";
  const str = String(value);
  const [intPartRaw, decPart] = str.split(".");
  const negative = intPartRaw.trim().startsWith("-");
  const intPart = intPartRaw.replace(/[^0-9]/g, "");
  if (!intPart) return decPart !== undefined ? `${negative ? "-" : ""}.${decPart}` : (negative ? "-" : "");
  const lastThree = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  const formattedRest = rest !== "" ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," : "";
  const formatted = formattedRest + lastThree;
  return (negative ? "-" : "") + (decPart !== undefined ? `${formatted}.${decPart}` : formatted);
}

// Strips everything except digits and a single decimal point, used to sanitize
// pasted/typed input before it's stored as the raw amount.
export function sanitizeAmountInput(value) {
  if (value === null || value === undefined) return "";
  let cleaned = String(value).replace(/[^0-9.]/g, "");
  const firstDot = cleaned.indexOf(".");
  if (firstDot !== -1) {
    cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
  }
  return cleaned;
}

// Converts a rupee amount into a compact Indian-unit breakdown, e.g.
// 1023456.5 -> "10 Lakh 23 Thousand 4 Hundred 56 Rupees And 50 Paise" —
// shown alongside the amount field so an accountant can visually
// double-check what was typed at a glance, without reading a long
// fully-spelled-out sentence.
export function amountToWordsIndian(value) {
  const num = Number(value);
  if (value === "" || value === null || value === undefined || isNaN(num)) return "";
  const negative = num < 0;
  const abs = Math.abs(num);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);

  let n = rupees;
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const hundred = Math.floor(n / 100); n %= 100;
  const remainder = n;

  const parts = [];
  if (crore) parts.push(`${crore} Crore`);
  if (lakh) parts.push(`${lakh} Lakh`);
  if (thousand) parts.push(`${thousand} Thousand`);
  if (hundred) parts.push(`${hundred} Hundred`);
  if (remainder) parts.push(`${remainder}`);

  let words = parts.length ? parts.join(" ") : "0";
  words += " Rupees";
  if (paise > 0) words += ` And ${paise} Paise`;
  return (negative ? "Minus " : "") + words;
}

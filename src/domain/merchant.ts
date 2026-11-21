/**
 * Payee cleaning: turn bank descriptors like
 *   "SQ *BLUE BOTTLE COFFEE OAKLAND CA" -> "Blue Bottle Coffee"
 *   "AMZN Mktp US*2K4L19XY2"            -> "Amazon"
 * The output is a stable merchant key that rules and merchant memory use.
 */

const PREFIXES = [
  /^(sq|sqsp|tst|toast|pp|paypal|pos|dbt|debit|purchase|ach|chk|checkcard|recurring|visa|mc)\s*[*#:-]\s*/i,
  /^(pos purchase|debit card purchase|purchase authorized on \d{2}\/\d{2}|recurring payment|preauthorized debit)\s*/i,
  /^(sp|in|ext|gpc|cke|ppd|web)\s*\*\s*/i,
];

const KNOWN: Array<[RegExp, string]> = [
  [/\bamzn|amazon\b|amazon\.com|prime video/i, "Amazon"],
  [/\bapple\.com\/bill|itunes/i, "Apple"],
  [/\bnetflix/i, "Netflix"],
  [/\bspotify/i, "Spotify"],
  [/\buber\s*eats/i, "Uber Eats"],
  [/\buber\b/i, "Uber"],
  [/\blyft/i, "Lyft"],
  [/\bdoordash|dd \*doordash/i, "DoorDash"],
  [/\bstarbucks/i, "Starbucks"],
  [/\btarget\b/i, "Target"],
  [/\bwal-?mart|wm supercenter/i, "Walmart"],
  [/\bcostco/i, "Costco"],
  [/\bwhole\s*foods|wholefds/i, "Whole Foods"],
  [/\btrader\s*joe/i, "Trader Joe's"],
  [/\bvenmo/i, "Venmo"],
  [/\bzelle/i, "Zelle"],
  [/\bshell oil|\bshell\b/i, "Shell"],
  [/\bchevron/i, "Chevron"],
  [/\bexxon|mobil\b/i, "ExxonMobil"],
  [/\bgoogle\s*\*?\s*(storage|one|youtube|play)/i, "Google"],
  [/\bhulu/i, "Hulu"],
  [/\bdisney\s*plus|disneyplus/i, "Disney+"],
  [/\bcomcast|xfinity/i, "Xfinity"],
  [/\bverizon/i, "Verizon"],
  [/\bt-mobile|tmobile/i, "T-Mobile"],
  [/\bat&t|\batt\b/i, "AT&T"],
];

const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC";

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function cleanPayee(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  for (const [re, name] of KNOWN) if (re.test(s)) return name;

  for (const re of PREFIXES) s = s.replace(re, "");
  // Remove trailing reference numbers, card digits, dates, phone numbers, URLs.
  s = s
    .replace(/\b\d{2}\/\d{2}(\/\d{2,4})?\b/g, " ")
    .replace(/\bx{2,}\d{2,}\b/gi, " ")
    .replace(/\b(card|crd)\s*\d{4}\b/gi, " ")
    .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, " ")
    .replace(/[#*]\s*[\w-]*\d[\w-]*/g, " ")
    .replace(/\b(store|str|unit)\s*#?\s*\d+\b/gi, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/\bwww\.|\.com\b/gi, " ");
  // Trailing "CITY ST" or "ST" state code.
  const beforeState = s;
  s = s.replace(new RegExp(`\\s+(${US_STATES})\\s*$`), "");
  // Drop one trailing city word when a state code was present and enough words remain.
  if (s !== beforeState) {
    const words = s.trim().split(/\s+/);
    if (words.length >= 3) s = words.slice(0, -1).join(" ");
  }
  s = s.replace(/[^\w&' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return titleCase(raw.trim().slice(0, 40));
  return titleCase(s);
}

/** Normalized key for grouping/matching (lowercase, alnum only). */
export function merchantKey(merchant: string): string {
  return merchant.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Similarity 0..1 between two payee strings using token Jaccard on cleaned names. */
export function payeeSimilarity(a: string, b: string): number {
  const ta = new Set(cleanPayee(a).toLowerCase().split(" ").filter(Boolean));
  const tb = new Set(cleanPayee(b).toLowerCase().split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Expand recipe/measurement shorthand for text-to-speech (tsp → teaspoon, etc.).
 */

const UNIT_RULES = [
  [/fl\.?\s*oz\.?/i, "fluid ounce", "fluid ounces"],
  [/floz/i, "fluid ounce", "fluid ounces"],
  [/tbsp?s?/i, "tablespoon", "tablespoons"],
  [/tsp?s?/i, "teaspoon", "teaspoons"],
  [/lbs?\.?/i, "pound", "pounds"],
  [/oz\.?/i, "ounce", "ounces"],
  [/kgs?/i, "kilogram", "kilograms"],
  [/(?<=\s|\d)g\b/i, "gram", "grams"],
  [/mls?/i, "milliliter", "milliliters"],
  [/(?<=\s|\d)l\b/i, "liter", "liters"],
  [/(?<=\s|\d)c\b/i, "cup", "cups"],
  [/pkgs?\.?/i, "package", "packages"],
];

const QTY_RE = /^(\d+)(?:\s+(\d+)\s*\/\s*(\d+))?$/;

function quantityValue(qty) {
  const m = String(qty).trim().match(QTY_RE);
  if (!m) return null;
  let val = parseFloat(m[1], 10);
  if (m[2] && m[3]) val += parseInt(m[2], 10) / parseInt(m[3], 10);
  return val;
}

function pickUnit(singular, plural, qty) {
  const val = quantityValue(qty);
  if (val == null) return singular;
  return Math.abs(val - 1) < 0.001 ? singular : plural;
}

const FRACTION_SPEAK = {
  "1/2": "a half",
  "1/3": "a third",
  "2/3": "two thirds",
  "1/4": "a quarter",
  "3/4": "three quarters",
  "1/8": "an eighth",
  "3/8": "three eighths",
};

export function normalizeForSpeech(text) {
  if (!text?.trim()) return text;

  let out = text;

  out = out.replace(/(\d+)\s*°\s*F\b/gi, "$1 degrees Fahrenheit");
  out = out.replace(/(\d+)\s*°\s*C\b/gi, "$1 degrees Celsius");
  out = out.replace(/(\d+)\s*degrees?\s*F\b/gi, "$1 degrees Fahrenheit");
  out = out.replace(/(\d+)\s*degrees?\s*C\b/gi, "$1 degrees Celsius");

  out = out.replace(/\b(\d+)\s*mins?\.\b/gi, "$1 minutes");
  out = out.replace(/\b(\d+)\s*hrs?\.\b/gi, "$1 hours");
  out = out.replace(/\b(\d+)\s*hrs?\b/gi, "$1 hours");

  for (const [pattern, singular, plural] of UNIT_RULES) {
    const qtyUnit = new RegExp(`(\\d[\\d\\s/.\\-]*)\\s*(${pattern.source})\\b`, "gi");
    out = out.replace(qtyUnit, (_, qty) => `${qty.trim()} ${pickUnit(singular, plural, qty)}`);
  }

  out = out.replace(/\b(\d+)\s+(\d+)\s*\/\s*(\d+)\b/g, (_, whole, n, d) => {
    const frac = FRACTION_SPEAK[`${n}/${d}`] || `${n} over ${d}`;
    return `${whole} and ${frac}`;
  });

  return out.replace(/\s+/g, " ").trim();
}

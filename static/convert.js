/** Client-side conversion + scaling engine. Pure functions, no DOM. */

const VOLUME_TO_ML = { tsp: 4.929, tbsp: 14.787, cup: 236.588, floz: 29.574, ml: 1, l: 1000 };
const WEIGHT_TO_G = { oz: 28.3495, lb: 453.592, g: 1, kg: 1000 };
const VOLUME_UNITS = new Set(["tsp", "tbsp", "cup", "floz", "ml", "l"]);
const WEIGHT_UNITS = new Set(["oz", "lb", "g", "kg"]);

let densities = {};

export async function loadDensities() {
  const res = await fetch("/data/densities.json");
  densities = await res.json();
  return densities;
}

export function scale(quantity, baseServings, targetServings) {
  if (quantity == null || !baseServings) return quantity;
  return (quantity * targetServings) / baseServings;
}

function roundToFraction(n, denominator = 8) {
  const whole = Math.floor(n);
  const frac = n - whole;
  const num = Math.round(frac * denominator);
  if (num === 0) return whole || 0;
  if (num === denominator) return whole + 1;
  const g = gcd(num, denominator);
  return whole ? `${whole} ${num / g}/${denominator / g}` : `${num / g}/${denominator / g}`;
}

function gcd(a, b) {
  return b ? gcd(b, a % b) : a;
}

export function formatQuantity(qty, unit) {
  if (qty == null) return "";
  if (unit == null) {
    const rounded = Math.round(qty * 2) / 2;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
  }
  if (WEIGHT_UNITS.has(unit)) {
    if (unit === "g" || unit === "kg") return String(Math.round(qty));
    return roundToFraction(qty, 8);
  }
  if (VOLUME_UNITS.has(unit)) return roundToFraction(qty, 8);
  return String(Math.round(qty * 100) / 100);
}

function volumeToCups(qty, unit) {
  const ml = qty * VOLUME_TO_ML[unit];
  return ml / VOLUME_TO_ML.cup;
}

function toMetricVolume(qty, unit) {
  const ml = qty * VOLUME_TO_ML[unit];
  if (ml >= 1000) return { quantity: Math.round((ml / 1000) * 10) / 10, unit: "l" };
  return { quantity: Math.round(ml), unit: "ml" };
}

function toImperialVolume(qty, unit) {
  const ml = qty * VOLUME_TO_ML[unit];
  if (ml >= VOLUME_TO_ML.cup * 0.25) {
    const cups = ml / VOLUME_TO_ML.cup;
    return { quantity: cups, unit: "cup" };
  }
  if (ml >= VOLUME_TO_ML.tbsp) {
    return { quantity: ml / VOLUME_TO_ML.tbsp, unit: "tbsp" };
  }
  return { quantity: ml / VOLUME_TO_ML.tsp, unit: "tsp" };
}

function toMetricWeight(qty, unit) {
  const g = qty * WEIGHT_TO_G[unit];
  if (g >= 1000) return { quantity: Math.round((g / 1000) * 10) / 10, unit: "kg" };
  return { quantity: Math.round(g), unit: "g" };
}

function toImperialWeight(qty, unit) {
  const g = qty * WEIGHT_TO_G[unit];
  if (g >= WEIGHT_TO_G.lb) return { quantity: g / WEIGHT_TO_G.lb, unit: "lb" };
  return { quantity: g / WEIGHT_TO_G.oz, unit: "oz" };
}

export function convertIngredient(ing, targetSystem, scaledQty) {
  const qty = scaledQty ?? ing.quantity;
  if (qty == null) return { quantity: null, unit: ing.unit, display: ing.raw };

  if (ing.unit == null) {
    const rounded = Math.round(qty * 2) / 2;
    return { quantity: rounded, unit: null, display: `${formatQuantity(rounded, null)} ${ing.item}` };
  }

  const isMetric = targetSystem === "metric";
  const isVolume = VOLUME_UNITS.has(ing.unit);
  const isWeight = WEIGHT_UNITS.has(ing.unit);

  if (isMetric && isVolume && ing.density_key && densities[ing.density_key]) {
    const cups = volumeToCups(qty, ing.unit);
    const grams = Math.round(cups * densities[ing.density_key]);
    const display = grams >= 1000
      ? `${Math.round((grams / 1000) * 10) / 10} kg ${ing.item}`
      : `${grams} g ${ing.item}`;
    return { quantity: grams, unit: "g", display };
  }

  let result;
  if (isVolume) {
    result = isMetric ? toMetricVolume(qty, ing.unit) : toImperialVolume(qty, ing.unit);
  } else if (isWeight) {
    result = isMetric ? toMetricWeight(qty, ing.unit) : toImperialWeight(qty, ing.unit);
  } else {
    result = { quantity: qty, unit: ing.unit };
  }

  const display = `${formatQuantity(result.quantity, result.unit)} ${result.unit} ${ing.item}`;
  return { ...result, display };
}

const TEMP_F_RE = /(\d{2,3})\s*°?\s*F/gi;

export function convertInstructionText(text, targetSystem) {
  if (targetSystem === "imperial") {
    return text.replace(/(\d{2,3})\s*°?\s*C/gi, (_, c) => {
      const f = Math.round((parseInt(c, 10) * 9) / 5 + 32);
      return `${f}°F`;
    });
  }
  return text.replace(TEMP_F_RE, (_, f) => {
    const c = Math.round(((parseInt(f, 10) - 32) * 5) / 9);
    return `${c}°C`;
  });
}

export function wrapInstructionTemps(text) {
  return text.replace(TEMP_F_RE, (match) => `<span data-original="${match}">${match}</span>`);
}

// Self-test when run directly
if (typeof window === "undefined") {
  densities = { flour_ap: 120 };
  console.assert(scale(2, 4, 8) === 4, "scale");
  const flour = convertIngredient(
    { quantity: 1, unit: "cup", item: "flour", density_key: "flour_ap" },
    "metric",
    1
  );
  console.assert(flour.unit === "g" && flour.quantity === 120, "smart weight");
  console.assert(convertInstructionText("Bake at 350°F", "metric").includes("176"), "temp");
  console.log("convert.js self-test passed");
}

/**
 * Kitchen heuristics for local voice commands (mirrors kitchen_knowledge.py).
 */

export const SECTION_ALIASES = {
  crust: ["crust", "pastry", "dough", "shell", "base", "bottom"],
  filling: ["filling", "inside", "center", "middle"],
  topping: ["topping", "top", "finish", "streusel"],
  frosting: ["frosting", "icing", "buttercream"],
  glaze: ["glaze", "ganache"],
  sauce: ["sauce", "gravy", "reduction"],
  batter: ["batter", "mixture"],
  marinade: ["marinade", "brine"],
  assembly: ["assembly", "assemble", "put together", "layer"],
  garnish: ["garnish"],
};

const DRY_KEYWORDS = [
  "flour",
  "sugar",
  "salt",
  "baking powder",
  "baking soda",
  "cocoa",
  "cornstarch",
  "starch",
  "oat",
  "meal",
  "semolina",
  "yeast",
  "spice",
  "cinnamon",
  "nutmeg",
  "pepper",
  "powder",
  "rice",
  "breadcrumb",
];

const WET_KEYWORDS = [
  "water",
  "milk",
  "cream",
  "egg",
  "oil",
  "butter",
  "juice",
  "broth",
  "stock",
  "vinegar",
  "wine",
  "honey",
  "syrup",
  "yogurt",
  "buttermilk",
  "vanilla",
  "extract",
  "molasses",
  "condensed",
  "evaporated",
  "coconut milk",
  "heavy cream",
  "sour cream",
];

const READ_VERB =
  "(?:read|list|tell|give|say|what are|what's|whats)";

export function resolveSection(query) {
  const q = query.toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(SECTION_ALIASES)) {
    if (q === canonical || aliases.includes(q)) return canonical;
  }
  for (const [canonical, aliases] of Object.entries(SECTION_ALIASES)) {
    if (aliases.some((a) => q.includes(a))) return canonical;
  }
  return q || null;
}

/** @returns {{ kind: string, label: string, section?: string } | null} */
export function parseKitchenQuery(transcript) {
  const t = transcript.toLowerCase().replace(/\s+/g, " ").trim();

  if (/\b(dry\s+(ingredients?|mix|goods)|all\s+(the\s+)?dry)\b/.test(t)) {
    return { kind: "dry", label: "Dry ingredients" };
  }
  if (/\b(wet\s+(ingredients?|mix)|all\s+(the\s+)?wet)\b/.test(t)) {
    return { kind: "wet", label: "Wet ingredients" };
  }

  let m = t.match(
    new RegExp(`\\b${READ_VERB}\\b.*\\b(?:the\\s+)?(\\w+(?:\\s+\\w+)?)\\s+ingredients?\\b`)
  );
  if (!m) m = t.match(/\bingredients?\s+for\s+(?:the\s+)?(\w+(?:\s+\w+)?)\b/);
  if (m) {
    const section = resolveSection(m[1]);
    if (section && !["dry", "wet", "all", "remaining"].includes(section)) {
      return {
        kind: "section_ingredients",
        section,
        label: `${section.charAt(0).toUpperCase()}${section.slice(1)} ingredients`,
      };
    }
  }

  m = t.match(
    new RegExp(
      `\\b${READ_VERB}\\b.*\\b(?:steps?|instructions?)\\b.*\\b(?:for|to|making|of)\\s+(?:the\\s+)?(\\w+(?:\\s+\\w+)?)\\b`
    )
  );
  if (!m) m = t.match(/\b(?:steps?|instructions?)\s+for\s+(?:the\s+)?(\w+(?:\s+\w+)?)\b/);
  if (m) {
    const section = resolveSection(m[1]);
    if (section) {
      return {
        kind: "section_steps",
        section,
        label: `${section.charAt(0).toUpperCase()}${section.slice(1)} steps`,
      };
    }
  }

  m = t.match(/\b(?:how (?:do i|to) make|making|make)\s+(?:the\s+)?(\w+(?:\s+\w+)?)\b/);
  if (m && /\b(steps?|instructions?|crust|filling|topping|frosting|sauce|batter)\b/.test(t)) {
    const section = resolveSection(m[1]);
    if (section) {
      return {
        kind: "section_steps",
        section,
        label: `${section.charAt(0).toUpperCase()}${section.slice(1)} steps`,
      };
    }
  }

  return null;
}

function ingText(ing) {
  return `${ing.item || ""} ${ing.raw || ""}`.toLowerCase();
}

export function classifyDryWet(ing) {
  const text = ingText(ing);
  const group = (ing.group || "").toLowerCase();
  if (group.includes("dry")) return "dry";
  if (group.includes("wet")) return "wet";

  let wetHits = WET_KEYWORDS.filter((k) => text.includes(k)).length;
  let dryHits = DRY_KEYWORDS.filter((k) => text.includes(k)).length;
  if (/\b(egg|eggs|milk|cream|butter|oil|water|juice|broth|stock)\b/.test(text)) wetHits += 2;
  if (/\b(flour|sugar|salt|powder|starch|yeast)\b/.test(text)) dryHits += 2;

  if (wetHits > dryHits && wetHits > 0) return "wet";
  if (dryHits > wetHits && dryHits > 0) return "dry";
  return null;
}

function sectionAliases(section) {
  const canonical = resolveSection(section) || section;
  return SECTION_ALIASES[canonical] || [canonical];
}

export function filterIngredients(visibleIngredients, query) {
  if (query.kind === "dry") {
    return visibleIngredients.filter((i) => classifyDryWet(i) === "dry");
  }
  if (query.kind === "wet") {
    return visibleIngredients.filter((i) => classifyDryWet(i) === "wet");
  }
  if (query.kind === "section_ingredients" && query.section) {
    const aliases = sectionAliases(query.section);
    return visibleIngredients.filter((ing) => {
      const g = (ing.group || "").toLowerCase();
      const text = ingText(ing);
      if (aliases.some((a) => g.includes(a))) return true;
      return aliases.some((a) => text.includes(a)) && !g;
    });
  }
  return [];
}

export function filterStepsForSection(instructions, section) {
  const aliases = sectionAliases(section);
  const matched = [];

  instructions.forEach((step, i) => {
    const text = (step.text || "").toLowerCase();
    if (aliases.some((a) => new RegExp(`\\b${a}\\b`).test(text))) {
      matched.push({ n: i + 1, step });
    }
  });
  if (matched.length) return matched;

  let startIdx = null;
  for (let i = 0; i < instructions.length; i++) {
    const text = (instructions[i].text || "").toLowerCase();
    if (startIdx === null) {
      if (aliases.some((a) => new RegExp(`^(for\\s+)?(the\\s+)?${a}\\b`).test(text))) {
        startIdx = i;
        matched.push({ n: i + 1, step: instructions[i] });
      }
    } else if (/^for\s+(the\s+)?\w+/.test(text)) {
      break;
    } else {
      matched.push({ n: i + 1, step: instructions[i] });
    }
  }
  return matched;
}

export function formatIngredientList(ingredients, label, ingredientDisplay) {
  if (!ingredients.length) {
    return `I don't see any ${label.toLowerCase()} in this recipe.`;
  }
  const parts = ingredients.map((ing, i) => `Number ${i + 1}: ${ingredientDisplay(ing)}`);
  return `${label}. ${parts.join(". ")}.`;
}

export function formatStepList(steps, label, stepDisplay) {
  if (!steps.length) {
    return `I don't see steps for ${label.toLowerCase()} in this recipe.`;
  }
  const parts = steps.map(({ n, step }) => `Step ${n}: ${stepDisplay(step)}`);
  return `${label}. ${parts.join(". ")}.`;
}

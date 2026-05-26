/**
 * Fast local cook commands + session context (mirrors server skills).
 */

import { scale, convertIngredient, convertInstructionText } from "./convert.js";
import {
  isPausePhrase,
  isResumePhrase,
  PAUSE_ACK,
  PAUSE_HINT,
  RESUME_ACK,
} from "./voice-pause-phrases.js";
import {
  filterIngredients,
  filterStepsForSection,
  formatIngredientList,
  formatStepList,
  parseKitchenQuery,
} from "./kitchen-knowledge.js";

export const COMMAND_HELP =
  "Next, back, repeat. Hold on to pause. Try: read dry ingredients, crust ingredients, or steps for the filling.";

/** @param {object} ctx */
export function buildSessionContext(ctx) {
  const { recipe, phase, index, getCookState, visibleIngredients, instructions } = ctx;
  const { servings, unitSystem } = getCookState();
  const currentIng = phase === "ingredients" ? visibleIngredients[index] : null;
  const currentStep = phase === "steps" ? instructions[index] : null;
  return {
    phase,
    index,
    servings,
    unit_system: unitSystem,
    base_servings: recipe.base_servings,
    ingredient_count: visibleIngredients.length,
    step_count: instructions.length,
    current_ingredient_item: currentIng?.item ?? null,
    current_step_number: currentStep ? index + 1 : null,
    remaining_ingredients: visibleIngredients.slice(index).map((i) => i.item),
    remaining_step_count:
      phase === "steps" ? Math.max(0, instructions.length - index) : instructions.length,
  };
}

/**
 * @returns {object|null} { action, speech?, servings?, unit_system?, phase?, index?, clientOnly? }
 */
export function matchLocalCommand(transcript, ctx) {
  const t = transcript.toLowerCase().trim();
  if (!t) return null;

  const {
    phase,
    index,
    paused,
    getCookState,
    setServings,
    setUnitSystem,
    visibleIngredients,
    instructions,
    ingredientDisplay,
    stepDisplay,
  } = ctx;

  if (/^(print|print recipe|print this)$/.test(t) || /\bprint (the )?recipe\b/.test(t)) {
    return { action: "print", clientOnly: true };
  }

  if (/^(stop|quit|exit|end assistant)$/.test(t)) {
    return { action: "stop", speech: "Stopping." };
  }

  if (!paused && isPausePhrase(transcript)) {
    return { action: "pause", speech: PAUSE_ACK };
  }

  if (paused && isResumePhrase(transcript)) {
    return { action: "resume", speech: RESUME_ACK };
  }

  if (paused) {
    if (/^(help|commands|what can i say)$/.test(t)) {
      return { action: "help", speech: PAUSE_HINT };
    }
    return null;
  }

  const kitchen = parseKitchenQuery(transcript);
  if (kitchen) {
    if (kitchen.kind === "section_steps" && kitchen.section) {
      const steps = filterStepsForSection(instructions, kitchen.section);
      return {
        action: "answer",
        speech: formatStepList(steps, kitchen.label, stepDisplay),
      };
    }
    const filtered = filterIngredients(visibleIngredients, kitchen);
    return {
      action: "answer",
      speech: formatIngredientList(filtered, kitchen.label, ingredientDisplay),
    };
  }

  if (/^(next|continue|done|ok|okay|yes|ready|go on|move on|skip)$/.test(t)) {
    return { action: "next" };
  }
  if (/^(back|previous)$/.test(t)) {
    return { action: "back" };
  }
  if (/^(repeat|again)$/.test(t)) {
    return { action: "repeat" };
  }
  if (/^(help|commands)$/.test(t)) {
    return { action: "help", speech: COMMAND_HELP };
  }

  const stepJump = t.match(/\b(?:go to |jump to )?step (\d+)\b/);
  if (stepJump) {
    const n = Math.max(1, parseInt(stepJump[1], 10));
    return { action: "goto", phase: "steps", index: n - 1, speech: `Step ${n}.` };
  }
  const ingJump = t.match(/\b(?:go to |jump to )?ingredient (\d+)\b/);
  if (ingJump) {
    const n = Math.max(1, parseInt(ingJump[1], 10));
    return { action: "goto", phase: "ingredients", index: n - 1, speech: `Ingredient ${n}.` };
  }

  if (
    /\b(read|list|tell|give|say|what are)\b/.test(t) &&
    /\b(remainder|remaining|rest of|left)\b/.test(t) &&
    /\bingredient/.test(t)
  ) {
    return { action: "read_remaining_ingredients" };
  }
  if (
    /\b(read|list|tell|give|say)\b/.test(t) &&
    /\b(remainder|remaining|rest of|left)\b/.test(t) &&
    /\b(step|instruction)/.test(t)
  ) {
    return { action: "read_remaining_steps" };
  }
  if (/\b(read|list|all)\b.*\bingredient/.test(t) && !/\b(remainder|remaining|left|rest)\b/.test(t)) {
    return { action: "read_all_ingredients" };
  }
  if (/\b(read|list|all)\b.*\b(step|instruction)/.test(t) && !/\b(remainder|remaining|left|rest)\b/.test(t)) {
    return { action: "read_all_steps" };
  }

  if (/\b(go to steps|start steps|instructions)\b/.test(t)) {
    return { action: "goto", phase: "steps", index: 0 };
  }
  if (/\b(go to ingredients|ingredient list)\b/.test(t)) {
    return { action: "goto", phase: "ingredients", index: 0 };
  }

  const scaleMatch = t.match(/\b(double|triple|half)\b/);
  const servingsMatch = t.match(/(\d+)\s*servings?/);
  if (scaleMatch || servingsMatch || /\bscale\b/.test(t)) {
    const { servings } = getCookState();
    let next = servings;
    if (scaleMatch) {
      const w = scaleMatch[1];
      if (w === "double") next = servings * 2;
      else if (w === "triple") next = servings * 3;
      else if (w === "half") next = Math.max(1, Math.round(servings / 2));
    }
    if (servingsMatch) next = Math.max(1, parseInt(servingsMatch[1], 10));
    setServings(next);
    return { action: "answer", speech: `${next} servings.`, servings: next };
  }

  if (/\b(metric|celsius)\b/.test(t) && setUnitSystem) {
    setUnitSystem("metric");
    return { action: "answer", speech: "Metric.", unit_system: "metric" };
  }
  if (/\b(imperial|fahrenheit)\b/.test(t)) {
    setUnitSystem("imperial");
    return { action: "answer", speech: "Imperial.", unit_system: "imperial" };
  }

  if (/\b(where am i|what step am i on)\b/.test(t)) {
    if (phase === "steps") {
      return { action: "answer", speech: `Step ${index + 1} of ${instructions.length}.` };
    }
    return {
      action: "answer",
      speech: `Ingredient ${index + 1} of ${visibleIngredients.length}.`,
    };
  }

  const byName = t.match(/\b(?:go to|jump to|find)\s+(.+?)(?:\s+ingredient)?$/);
  if (byName) {
    const q = byName[1].trim();
    const i = visibleIngredients.findIndex((ing) =>
      ing.item.toLowerCase().includes(q)
    );
    if (i >= 0) {
      return {
        action: "goto",
        phase: "ingredients",
        index: i,
        speech: ingredientDisplay(visibleIngredients[i]),
      };
    }
  }

  return null;
}

const FAST_PATTERNS = [
  /^(next|continue|done|ok|okay|yes|ready|go on|move on|skip)$/,
  /^(back|previous|repeat|again|stop|quit|help)$/,
  /^(print|print recipe|print this)$/,
  /^(metric|imperial)$/,
  /\b(double|triple|half)\b/,
  /^\d+\s*servings?$/,
  /\b(read|list).*(remaining|rest of|left)/,
  /\bgo to (step|ingredient) \d+/,
  /\b(hold on|hang on|hold up|wait|pause|stand by)\b/,
  /\b(i'?m back|let'?s go|start again|begin again)\b/,
  /\b(dry|wet)\s+ingredients?\b/,
  /\bingredients?\s+for\s+(?:the\s+)?\w+/,
  /\bsteps?\s+for\s+(?:the\s+)?\w+/,
];

export function needsLlm(transcript) {
  const t = transcript.toLowerCase().trim();
  if (!t) return false;
  if (parseKitchenQuery(transcript)) return false;
  if (FAST_PATTERNS.some((re) => re.test(t))) return false;
  if (/\b(substitut|instead of|swap|replace|can i use|what if)\b/.test(t)) return true;
  if (/\b(how much|how many|oven|temperature|refrigerat|how long|safe|internal temp)\b/.test(t)) {
    return true;
  }
  if (/\b(technique|mean|difference|equipment|tool|saut[eé]|braise|blanch)\b/.test(t)) return true;
  if (/^(how|what|why|can|should|is|are|does|explain|tell me)\b/.test(t)) return true;
  return t.split(/\s+/).length > 4;
}

export function formatAllIngredients(ctx) {
  const { visibleIngredients, ingredientDisplay } = ctx;
  if (!visibleIngredients.length) return "No ingredients to read.";
  const parts = visibleIngredients.map((ing) => ingredientDisplay(ing));
  return `Ingredients. ${parts.join(". ")}.`;
}

export function formatRemainingIngredients(ctx, fromStart) {
  const { visibleIngredients, index, ingredientDisplay } = ctx;
  const slice = fromStart ? visibleIngredients : visibleIngredients.slice(index);
  if (!slice.length) return "No ingredients to read.";
  if (fromStart) return formatAllIngredients(ctx);
  const parts = slice.map((ing, i) => `${index + i + 1}: ${ingredientDisplay(ing)}`);
  return `Remaining ingredients. ${parts.join(". ")}.`;
}

export function formatRemainingSteps(ctx, fromStart) {
  const { instructions, index, stepDisplay } = ctx;
  const slice = fromStart ? instructions : instructions.slice(index);
  if (!slice.length) return "No steps to read.";
  const start = fromStart ? 1 : index + 1;
  const parts = slice.map((s, i) => `Step ${start + i}: ${stepDisplay(s)}`);
  const label = fromStart ? "All steps" : "Remaining steps";
  return `${label}. ${parts.join(". ")}.`;
}

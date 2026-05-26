/**
 * Hands-free cook assistant: speaks ingredients/steps one at a time,
 * listens for confirmation and verbal questions. Uses Web Speech API only.
 */

import { scale, convertIngredient, convertInstructionText } from "./convert.js";

const SpeechRecognition =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

export function voiceAssistantSupported() {
  return !!(window.speechSynthesis && SpeechRecognition);
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(s) {
  return normalize(s).split(" ").filter((w) => w.length > 1);
}

function wordOverlapScore(a, b) {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (!wa.size || !wb.size) return 0;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  return hit / Math.max(wa.size, wb.size);
}

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const preferred = voices.find(
    (v) => v.lang.startsWith("en") && /samantha|google us english|natural|premium/i.test(v.name)
  );
  return preferred || voices.find((v) => v.lang.startsWith("en")) || voices[0];
}

export class CookVoiceAssistant {
  /**
   * @param {object} opts
   * @param {object} opts.recipe
   * @param {() => { servings: number, unitSystem: string }} opts.getCookState
   * @param {(n: number) => void} opts.setServings
   * @param {(s: string) => void} [opts.setUnitSystem]
   * @param {(info: { phase: string, index: number } | null) => void} opts.onHighlight
   * @param {(status: object) => void} opts.onStatus
   */
  constructor(opts) {
    this.recipe = opts.recipe;
    this.getCookState = opts.getCookState;
    this.setServings = opts.setServings;
    this.setUnitSystem = opts.setUnitSystem;
    this.onHighlight = opts.onHighlight;
    this.onStatus = opts.onStatus;

    this.active = false;
    this.paused = false;
    this.phase = "ingredients";
    this.index = 0;
    this._recognition = null;
    this._listening = false;
    this._speakResolve = null;
    this._voice = null;
    this._boundVoices = this._onVoicesChanged.bind(this);
  }

  get visibleIngredients() {
    const hidden = new Set(this.recipe.layout?.hidden_ingredient_ids || []);
    return this.recipe.ingredients.filter((ing) => !hidden.has(ing.id));
  }

  get instructions() {
    const order = this.recipe.layout?.step_order;
    const steps = [...this.recipe.instructions];
    if (order?.length) {
      const byStep = new Map(steps.map((s) => [s.step, s]));
      return order.map((n) => byStep.get(n)).filter(Boolean);
    }
    return steps.sort((a, b) => a.step - b.step);
  }

  ingredientDisplay(ing) {
    const { servings, unitSystem } = this.getCookState();
    const scaled = scale(ing.quantity, this.recipe.base_servings, servings);
    return convertIngredient(ing, unitSystem, scaled).display;
  }

  stepDisplay(step) {
    const { unitSystem } = this.getCookState();
    return convertInstructionText(step.text, unitSystem);
  }

  _emit(extra = {}) {
    const ingCount = this.visibleIngredients.length;
    const stepCount = this.instructions.length;
    let label = "";
    if (this.phase === "ingredients" && ingCount) {
      label = `Ingredient ${this.index + 1} of ${ingCount}`;
    } else if (this.phase === "steps" && stepCount) {
      label = `Step ${this.index + 1} of ${stepCount}`;
    }
    this.onStatus({
      active: this.active,
      paused: this.paused,
      phase: this.phase,
      index: this.index,
      label,
      listening: this._listening,
      ...extra,
    });
  }

  _onVoicesChanged() {
    this._voice = pickVoice();
  }

  async start() {
    if (this.active) return;
    this.active = true;
    this.paused = false;
    this.phase = "ingredients";
    this.index = 0;
    speechSynthesis.addEventListener("voiceschanged", this._boundVoices);
    this._voice = pickVoice();
    this._emit({ message: "Starting…" });
    const ingN = this.visibleIngredients.length;
    const stepN = this.instructions.length;
    await this.speak(
      `Cooking ${this.recipe.title}. ${ingN} ingredients and ${stepN} steps. ` +
        `I'll read each one. Say next when you're ready, or ask me a question anytime.`
    );
    await this._presentCurrent();
  }

  stop() {
    this.active = false;
    this.paused = false;
    this._stopListening();
    speechSynthesis.cancel();
    if (this._speakResolve) {
      this._speakResolve();
      this._speakResolve = null;
    }
    speechSynthesis.removeEventListener("voiceschanged", this._boundVoices);
    this.onHighlight(null);
    this._emit({ message: "" });
  }

  speak(text) {
    return new Promise((resolve) => {
      speechSynthesis.cancel();
      this._stopListening();
      const utter = new SpeechSynthesisUtterance(text);
      if (this._voice) utter.voice = this._voice;
      utter.rate = 0.95;
      utter.pitch = 1;
      this._speakResolve = resolve;
      utter.onend = () => {
        this._speakResolve = null;
        resolve();
      };
      utter.onerror = () => {
        this._speakResolve = null;
        resolve();
      };
      speechSynthesis.speak(utter);
    });
  }

  _stopListening() {
    if (this._recognition) {
      try {
        this._recognition.abort();
      } catch {
        /* ignore */
      }
    }
    this._listening = false;
  }

  listen() {
    return new Promise((resolve) => {
      if (!this.active || this.paused) {
        resolve("");
        return;
      }
      const rec = new SpeechRecognition();
      this._recognition = rec;
      rec.lang = "en-US";
      rec.interimResults = false;
      rec.maxAlternatives = 3;
      rec.continuous = false;

      let settled = false;
      const finish = (text) => {
        if (settled) return;
        settled = true;
        this._listening = false;
        this._emit();
        resolve(text);
      };

      rec.onresult = (event) => {
        const texts = [];
        for (let i = event.resultIndex; i < event.results.length; i++) {
          texts.push(event.results[i][0].transcript);
        }
        finish(normalize(texts.join(" ")));
      };
      rec.onerror = () => finish("");
      rec.onend = () => {
        if (!settled) finish("");
      };

      this._listening = true;
      this._emit({ message: "Listening…" });
      try {
        rec.start();
      } catch {
        finish("");
      }
    });
  }

  async _loopListen() {
    while (this.active && !this.paused) {
      const transcript = await this.listen();
      if (!this.active) break;
      if (!transcript) {
        await this.speak("I didn't catch that. Try again, or say help for commands.");
        await this._presentCurrent(false);
        continue;
      }
      const handled = await this._handleCommand(transcript);
      if (handled === "stop") break;
      if (handled === "pause") continue;
      if (!handled) {
        await this.speak("I didn't understand. Say next, repeat, or help.");
        await this._presentCurrent(false);
      }
    }
  }

  async _presentCurrent(intro = true) {
    if (!this.active) return;
    const ings = this.visibleIngredients;
    const steps = this.instructions;

    if (this.phase === "ingredients") {
      if (!ings.length) {
        this.phase = "steps";
        this.index = 0;
        return this._presentCurrent(intro);
      }
      if (this.index >= ings.length) {
        await this.speak("That's all the ingredients. Say next for step one.");
        this.phase = "steps";
        this.index = 0;
        this.onHighlight({ phase: "steps", index: 0 });
        this._emit();
        return this._loopListen();
      }
      const ing = ings[this.index];
      this.onHighlight({ phase: "ingredients", index: this.index });
      this._emit();
      const line = intro
        ? `Ingredient ${this.index + 1} of ${ings.length}: ${this.ingredientDisplay(ing)}. Say next when ready.`
        : `${this.ingredientDisplay(ing)}. Say next when ready.`;
      await this.speak(line);
      return this._loopListen();
    }

    if (this.index >= steps.length) {
      await this.speak(`You're done. Enjoy your ${this.recipe.title}.`);
      this.stop();
      return;
    }
    const step = steps[this.index];
    this.onHighlight({ phase: "steps", index: this.index });
    this._emit();
    const line = intro
      ? `Step ${this.index + 1} of ${steps.length}: ${this.stepDisplay(step)}. Say next when ready.`
      : `${this.stepDisplay(step)}. Say next when ready.`;
    await this.speak(line);
    return this._loopListen();
  }

  async _handleCommand(transcript) {
    const t = transcript;

    if (/\b(stop|quit|exit|end assistant|turn off)\b/.test(t)) {
      await this.speak("Stopping voice assistant.");
      this.stop();
      return "stop";
    }

    if (/\b(pause|hold on|wait)\b/.test(t) && !/\b(unpause|resume)\b/.test(t)) {
      this.paused = true;
      this._stopListening();
      speechSynthesis.cancel();
      this._emit({ message: "Paused" });
      await this.speak("Paused. Say resume when you're ready.");
      return "pause";
    }

    if (/\b(resume|unpause|continue assistant|i'm back)\b/.test(t)) {
      if (this.paused) {
        this.paused = false;
        await this.speak("Resuming.");
        await this._presentCurrent(false);
      }
      return true;
    }

    if (/\b(help|what can i say|commands)\b/.test(t)) {
      await this.speak(
        "Say next or done to move on. Repeat to hear again. Back for previous. " +
          "Ask how much of an ingredient, oven temperature, or how long to refrigerate. " +
          "Say double the recipe or switch to metric. Say pause or stop."
      );
      return true;
    }

    if (/\b(repeat|again|say again|what was that|one more time)\b/.test(t)) {
      await this._presentCurrent(false);
      return true;
    }

    if (/\b(where am i|what step|current step|which step)\b/.test(t)) {
      const steps = this.instructions;
      if (this.phase === "steps" && steps[this.index]) {
        await this.speak(`You're on step ${this.index + 1} of ${steps.length}.`);
      } else if (this.phase === "ingredients") {
        await this.speak(
          `Still on ingredients. Item ${this.index + 1} of ${this.visibleIngredients.length}.`
        );
      }
      return true;
    }

    if (/\b(back|previous|go back)\b/.test(t)) {
      if (this.index > 0) {
        this.index--;
        await this.speak("Going back.");
        await this._presentCurrent();
      } else {
        await this.speak("You're at the beginning.");
      }
      return true;
    }

    if (/\b(next|continue|done|got it|okay|ok|yes|ready|move on|go on)\b/.test(t)) {
      this.index++;
      await this._presentCurrent();
      return true;
    }

    if (/\b(go to steps|start steps|instructions|read steps)\b/.test(t)) {
      this.phase = "steps";
      this.index = 0;
      await this.speak("Starting instructions.");
      await this._presentCurrent();
      return true;
    }

    if (/\b(ingredients|read ingredients|back to ingredients)\b/.test(t)) {
      this.phase = "ingredients";
      this.index = 0;
      await this.speak("Starting ingredients.");
      await this._presentCurrent();
      return true;
    }

    const scaleMatch = t.match(/\b(double|triple|half)\b/);
    const servingsMatch = t.match(/(\d+)\s*servings?/);
    if (scaleMatch || servingsMatch || /\bscale\b/.test(t)) {
      const { servings } = this.getCookState();
      let next = servings;
      if (scaleMatch) {
        const word = scaleMatch[1];
        if (word === "double") next = servings * 2;
        else if (word === "triple") next = servings * 3;
        else if (word === "half") next = Math.max(1, Math.round(servings / 2));
      }
      if (servingsMatch) next = Math.max(1, parseInt(servingsMatch[1], 10));
      this.setServings(next);
      await this.speak(`Scaled to ${next} servings.`);
      return true;
    }

    if (/\b(metric|celsius|centigrade)\b/.test(t) && this.setUnitSystem) {
      this.setUnitSystem("metric");
      await this.speak("Switched to metric.");
      return true;
    }
    if (/\b(imperial|fahrenheit)\b/.test(t) && this.setUnitSystem) {
      this.setUnitSystem("imperial");
      await this.speak("Switched to imperial.");
      return true;
    }

    const lastIng = /\b(last ingredient|final ingredient)\b/.test(t);
    if (lastIng) {
      const ings = this.visibleIngredients;
      if (!ings.length) {
        await this.speak("No ingredients listed.");
        return true;
      }
      const ing = ings[ings.length - 1];
      await this.speak(`Last ingredient: ${this.ingredientDisplay(ing)}.`);
      return true;
    }

    const tempAnswer = this._answerTemperature(t);
    if (tempAnswer) {
      await this.speak(tempAnswer);
      return true;
    }

    const timeAnswer = this._answerTime(t);
    if (timeAnswer) {
      await this.speak(timeAnswer);
      return true;
    }

    const ingAnswer = this._answerIngredient(t);
    if (ingAnswer) {
      await this.speak(ingAnswer);
      return true;
    }

    const currentIng = this._currentIngredientAmount();
    if (currentIng && /\b(this|that)\b/.test(t) && /\b(how much|amount|quantity)\b/.test(t)) {
      await this.speak(currentIng);
      return true;
    }

    return false;
  }

  _currentIngredientAmount() {
    if (this.phase !== "ingredients") return null;
    const ing = this.visibleIngredients[this.index];
    if (!ing) return null;
    return `For this ingredient: ${this.ingredientDisplay(ing)}.`;
  }

  _answerIngredient(transcript) {
    const m =
      transcript.match(/how much (.+?)(?:\s+(?:go|went|goes|do i need))?(?:\?|$)/) ||
      transcript.match(/(?:what(?:'s| is) the amount of|amount of|quantity of) (.+?)(?:\?|$)/) ||
      transcript.match(/how many (.+?)(?:\?|$)/);
    if (!m) return null;
    const query = m[1].replace(/\b(in this|for this|did i use)\b/g, "").trim();
    const ing = this._findIngredient(query);
    if (!ing) return `I couldn't find ${query} in the ingredient list.`;
    return `${ing.item}: ${this.ingredientDisplay(ing)}.`;
  }

  _findIngredient(query) {
    const q = normalize(query);
    const ings = this.visibleIngredients;
    let best = null;
    let bestScore = 0.35;
    for (const ing of ings) {
      const item = normalize(ing.item);
      if (item.includes(q) || q.includes(item)) return ing;
      const score = wordOverlapScore(q, item);
      if (score > bestScore) {
        bestScore = score;
        best = ing;
      }
    }
    return best;
  }

  _allText() {
    const parts = [
      this.recipe.notes || "",
      ...this.instructions.map((s) => s.text),
    ];
    return parts.join("\n");
  }

  _answerTemperature(transcript) {
    if (!/\b(oven|temperature|preheat|degrees|°|set at|how hot)\b/.test(transcript)) return null;
    const { unitSystem } = this.getCookState();
    const corpus = convertInstructionText(this._allText(), unitSystem);
    const temps = [];
    const reF = /(\d{2,3})\s*°?\s*F/gi;
    const reC = /(\d{2,3})\s*°?\s*C/gi;
    let match;
    while ((match = reF.exec(corpus))) temps.push(`${match[1]}°F`);
    while ((match = reC.exec(corpus))) temps.push(`${match[1]}°C`);
    if (!temps.length) return "I don't see an oven temperature in this recipe.";
    const unique = [...new Set(temps)];
    if (unique.length === 1) return `The recipe says ${unique[0]}.`;
    return `I found these temperatures: ${unique.join(", ")}.`;
  }

  _answerTime(transcript) {
    if (!/\b(how long|refrigerat|chill|rest|cool|bake|cook|simmer|wait)\b/.test(transcript)) {
      return null;
    }
    const corpus = this._allText();
    const patterns = [
      /refrigerat\w*[^.]{0,80}?(\d+(?:\s*-\s*\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?)/i,
      /(?:chill|cool|rest)\w*[^.]{0,60}?(\d+(?:\s*-\s*\d+)?)\s*(minutes?|mins?|hours?|hrs?)/i,
      /(?:bake|cook|simmer)\w*[^.]{0,40}?(\d+(?:\s*-\s*\d+)?)\s*(minutes?|mins?|hours?|hrs?)/i,
    ];
    for (const re of patterns) {
      const m = corpus.match(re);
      if (m) {
        const ctx = m[0].trim().slice(0, 120);
        return `From the recipe: ${ctx}.`;
      }
    }
    if (/\brefrigerat/i.test(transcript)) {
      return "I don't see a specific refrigerate time. Check the notes or final steps.";
    }
    return null;
  }
}

/**
 * Hands-free cook assistant: cloud STT/TTS, fast local commands, mobile-friendly.
 */

import {
  buildSessionContext,
  COMMAND_HELP,
  formatAllIngredients,
  formatRemainingIngredients,
  formatRemainingSteps,
  matchLocalCommand,
  needsLlm,
} from "./cook-commands.js";
import { tryCookingBasicsAnswer } from "./cooking-basics.js";
import { isInterruptPhrase, isResumePhrase } from "./voice-pause-phrases.js";
import { normalizeForSpeech } from "./speech-speak.js";
import { scale, convertIngredient, convertInstructionText } from "./convert.js";

const SpeechRecognition =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

export const DEFAULT_VOICE_SETTINGS = {
  tts_voice: "nova",
  tts_model: "tts-1",
  use_cloud_tts: true,
  verbosity: "minimal",
  prompt_once: true,
  listen_seconds: 3.2,
  speech_rate: 1.15,
  push_to_talk: false,
  personality:
    "You are a warm, encouraging cooking companion. Keep replies short and natural.",
  assistant_name: "",
  custom_commands: [],
};

export async function fetchVoiceBackend() {
  try {
    const res = await fetch("/api/cook/voice/status", { credentials: "include" });
    if (!res.ok) return { enabled: false };
    return await res.json();
  } catch {
    return { enabled: false };
  }
}

export async function fetchVoiceSettings() {
  try {
    const res = await fetch("/api/cook/voice/settings", { credentials: "include" });
    if (!res.ok) return { ...DEFAULT_VOICE_SETTINGS };
    return { ...DEFAULT_VOICE_SETTINGS, ...(await res.json()) };
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

export async function saveVoiceSettings(settings) {
  const res = await fetch("/api/cook/voice/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error("Could not save voice settings");
  return res.json();
}

export function voiceAssistantSupported(backend = { enabled: false }) {
  const hasMic = !!(navigator.mediaDevices?.getUserMedia);
  const hasLocalStt = !!SpeechRecognition;
  const hasSpeak = !!window.speechSynthesis || backend.enabled;
  if (!hasMic || !hasSpeak) return false;
  return hasLocalStt || backend.enabled;
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
  constructor(opts) {
    this.recipe = opts.recipe;
    this.settings = { ...DEFAULT_VOICE_SETTINGS, ...(opts.settings || {}) };
    this.getCookState = opts.getCookState;
    this.setServings = opts.setServings;
    this.setUnitSystem = opts.setUnitSystem;
    this.onHighlight = opts.onHighlight;
    this.onStatus = opts.onStatus;
    this.onPrint = opts.onPrint;
    this.backend = opts.backend ?? { enabled: false };
    this.useCloudListen = !!this.backend.enabled;
    this.useCloudInterpret = !!this.backend.enabled;
    this.useCloudTts = !!this.backend.enabled && this.settings.use_cloud_tts;

    this.active = false;
    this.paused = false;
    this.phase = "ingredients";
    this.index = 0;
    this._controlsExplained = false;
    this._recognition = null;
    this._listening = false;
    this._speakResolve = null;
    this._voice = null;
    this._audio = null;
    this._boundVoices = this._onVoicesChanged.bind(this);
    this._micStream = null;
    this._hearCtx = null;
    this._hearAnalyser = null;
    this._hearRaf = null;
    this._hearing = false;
    this._hearLevel = 0;
    this._listenAbort = false;
    this._mediaRecorder = null;
    this._recordTimer = null;
    this._loopRunning = false;
    this._lastHearEmit = 0;
    this._speakChain = Promise.resolve();
    this._speakTicket = 0;
    this._speaking = false;
    this._interruptRec = null;
    this._listenMs = () => Math.round((this.settings.listen_seconds ?? 3.2) * 1000);
  }

  _speechRate() {
    const r = Number(this.settings.speech_rate);
    if (!Number.isFinite(r)) return 1;
    return Math.min(1.5, Math.max(0.75, r));
  }

  _haltSpeechPlayback() {
    speechSynthesis.cancel();
    if (this._speakResolve) {
      this._speakResolve();
      this._speakResolve = null;
    }
    if (this._audio) {
      this._audio.pause();
      if (this._audio.src) URL.revokeObjectURL(this._audio.src);
      this._audio = null;
    }
  }

  _abortActiveListen() {
    this._listenAbort = true;
    if (this._recordTimer) {
      clearTimeout(this._recordTimer);
      this._recordTimer = null;
    }
    if (this._mediaRecorder) {
      try {
        if (this._mediaRecorder.state === "recording") this._mediaRecorder.stop();
      } catch {
        /* ignore */
      }
      this._mediaRecorder = null;
    }
    if (this._recognition) {
      try {
        this._recognition.abort();
      } catch {
        /* ignore */
      }
      this._recognition = null;
    }
    this._listening = false;
    this._stopHearMonitor();
  }

  _pausedListenDelay() {
    return new Promise((r) => setTimeout(r, 450));
  }

  _stopHearMonitor() {
    if (this._hearRaf) {
      cancelAnimationFrame(this._hearRaf);
      this._hearRaf = null;
    }
    if (this._hearCtx) {
      this._hearCtx.close().catch(() => {});
      this._hearCtx = null;
    }
    this._hearAnalyser = null;
    this._hearing = false;
    this._hearLevel = 0;
  }

  async _startHearMonitor() {
    this._stopHearMonitor();
    if (!this._micStream) {
      try {
        await this._warmMic();
      } catch {
        return;
      }
    }
    if (!this._micStream) return;

    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(this._micStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);
      this._hearCtx = ctx;
      this._hearAnalyser = analyser;
      const bins = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        if (!this._listening) return;
        analyser.getByteFrequencyData(bins);
        let sum = 0;
        for (let i = 0; i < bins.length; i++) sum += bins[i];
        const level = Math.min(1, sum / bins.length / 72);
        this._hearing = level > 0.07;
        this._hearLevel = level;
        const now = Date.now();
        if (now - this._lastHearEmit > 80) {
          this._lastHearEmit = now;
          this._emit();
        }
        this._hearRaf = requestAnimationFrame(tick);
      };
      this._hearRaf = requestAnimationFrame(tick);
    } catch {
      this._stopHearMonitor();
    }
  }

  _commandCtx() {
    return {
      recipe: this.recipe,
      phase: this.phase,
      index: this.index,
      paused: this.paused,
      getCookState: this.getCookState,
      setServings: this.setServings,
      setUnitSystem: this.setUnitSystem,
      visibleIngredients: this.visibleIngredients,
      instructions: this.instructions,
      ingredientDisplay: (ing) => this.ingredientDisplay(ing),
      stepDisplay: (s) => this.stepDisplay(s),
    };
  }

  tapNext() {
    if (!this.active || this.paused) return;
    this.index++;
    return this._presentCurrent(false);
  }

  tapBack() {
    if (!this.active || this.paused) return;
    if (this.index > 0) this.index--;
    return this._presentCurrent(false);
  }

  async tapListen() {
    if (!this.active) return;
    const transcript = await this.listen({ forResume: this.paused });
    if (transcript) await this._handleCommand(transcript);
    else if (this.paused) this._emit({ message: "Paused — say when you're back" });
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

  _verbosity() {
    return this.settings.verbosity || "minimal";
  }

  _promptSuffix() {
    if (this._verbosity() === "minimal") return "";
    if (this._verbosity() === "chatty") {
      return " Say next when you're ready, or ask me anything.";
    }
    return " Say next when ready.";
  }

  _ingredientLine(ing, num, total, announceIndex) {
    const text = this.ingredientDisplay(ing);
    if (this._verbosity() === "minimal" && !announceIndex) return text;
    if (announceIndex) return `Ingredient ${num} of ${total}: ${text}`;
    return `${text}.`;
  }

  _stepLine(step, num, total, announceIndex) {
    const text = this.stepDisplay(step);
    if (this._verbosity() === "minimal" && !announceIndex) return text;
    if (announceIndex) return `Step ${num} of ${total}: ${text}`;
    return `${text}.`;
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
      hearing: this._hearing,
      hearLevel: this._hearLevel,
      speaking: this._speaking,
      cloud: this.useCloudListen,
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
    this._controlsExplained = false;
    speechSynthesis.addEventListener("voiceschanged", this._boundVoices);
    this._voice = pickVoice();
    if (this.useCloudListen) await this._warmMic();
    this._emit({ message: "Starting…" });

    const ingN = this.visibleIngredients.length;
    const stepN = this.instructions.length;
    const name = this.settings.assistant_name?.trim();
    const greet = name ? `${name} here. ` : "";

    if (this._verbosity() === "minimal" && this.settings.prompt_once) {
      await this.speak(
        `${greet}Cooking ${this.recipe.title}. ${ingN} ingredients, ${stepN} steps. ` +
          `I'll read the ingredients now — say hold on anytime to pause.`
      );
      this._controlsExplained = true;
    } else {
      await this.speak(
        `${greet}Cooking ${this.recipe.title}. ${ingN} ingredients and ${stepN} steps. ` +
          `I'll list the ingredients, then we'll go step by step. Ask me anything anytime.`
      );
      this._controlsExplained = true;
    }
    await this._presentCurrent();
    if (this.active && !this.settings.push_to_talk) {
      await this._loopListen();
    }
  }

  stop() {
    this.active = false;
    this.paused = false;
    this._speakTicket += 1;
    this._speakChain = Promise.resolve();
    this._speaking = false;
    this._stopInterruptListen();
    this._abortActiveListen();
    this._releaseMic();
    this._haltSpeechPlayback();
    speechSynthesis.removeEventListener("voiceschanged", this._boundVoices);
    this.onHighlight(null);
    this._emit({ message: "" });
  }

  speak(text, opts = {}) {
    if (!text?.trim()) return Promise.resolve({ status: "done" });
    let done;
    const promise = new Promise((resolve) => {
      done = resolve;
    });
    this._speakChain = this._speakChain
      .then(async () => {
        if (opts.interruptible) return this._speakInterruptible(text);
        await this._speakOnce(text);
        return { status: "done" };
      })
      .then(done, () => done({ status: "done" }));
    return promise;
  }

  _startInterruptListen(onInterrupt) {
    if (!SpeechRecognition || !this.active) return null;
    const rec = new SpeechRecognition();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const chunk = normalize(result[0].transcript);
        if (!chunk) continue;
        const isQuestion =
          result.isFinal &&
          /^(how|what|why|can|should|is|are|does|tell me|explain)\b/.test(chunk) &&
          chunk.split(/\s+/).length >= 3;
        if (isInterruptPhrase(chunk) || isQuestion) onInterrupt(chunk);
      }
    };
    rec.onerror = () => {};
    rec.onend = () => {
      if (this._interruptRec === rec && this._speaking && this.active) {
        try {
          rec.start();
        } catch {
          /* ignore */
        }
      }
    };
    try {
      rec.start();
    } catch {
      return null;
    }
    this._interruptRec = rec;
    return rec;
  }

  _stopInterruptListen() {
    if (this._interruptRec) {
      try {
        this._interruptRec.stop();
      } catch {
        /* ignore */
      }
      this._interruptRec = null;
    }
  }

  async _speakInterruptible(text) {
    const spoken = normalizeForSpeech(text);
    const ticket = ++this._speakTicket;
    this._abortActiveListen();
    this._haltSpeechPlayback();
    this._speaking = true;
    this._emit();

    let interruptTranscript = null;
    const onInterrupt = (chunk) => {
      if (!interruptTranscript) {
        interruptTranscript = chunk;
        this._haltSpeechPlayback();
      }
    };

    this._startInterruptListen(onInterrupt);

    try {
      await this._playSpeech(spoken, ticket);
    } finally {
      this._stopInterruptListen();
      if (ticket === this._speakTicket) {
        this._speaking = false;
        this._emit();
      }
    }

    if (interruptTranscript) {
      return { status: "interrupted", transcript: interruptTranscript };
    }
    return { status: "done" };
  }

  async _playSpeech(spoken, ticket) {
    const stillValid = () => ticket === this._speakTicket;

    if (this.useCloudTts) {
      try {
        const res = await fetch("/api/cook/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ text: spoken }),
        });
        if (!stillValid()) return;
        if (res.ok) {
          const blob = await res.blob();
          if (!stillValid()) return;
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          this._audio = audio;
          audio.playbackRate = 1;
          await new Promise((resolve) => {
            const finish = () => {
              URL.revokeObjectURL(url);
              if (this._audio === audio) this._audio = null;
              resolve();
            };
            audio.onended = finish;
            audio.onerror = finish;
            audio.play().catch(finish);
          });
          if (!stillValid()) this._haltSpeechPlayback();
          return;
        }
      } catch {
        /* fallback to browser */
      }
    }

    if (!stillValid()) return;

    await new Promise((resolve) => {
      const utter = new SpeechSynthesisUtterance(spoken);
      if (this._voice) utter.voice = this._voice;
      utter.rate = this._speechRate();
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
    if (!stillValid()) this._haltSpeechPlayback();
  }

  async _speakOnce(text) {
    const spoken = normalizeForSpeech(text);
    const ticket = ++this._speakTicket;
    this._abortActiveListen();
    this._haltSpeechPlayback();
    this._speaking = true;
    this._emit();

    try {
      await this._playSpeech(spoken, ticket);
    } finally {
      if (ticket === this._speakTicket) {
        this._speaking = false;
        this._emit();
      }
    }
  }

  _releaseMic() {
    if (this._micStream) {
      this._micStream.getTracks().forEach((t) => t.stop());
      this._micStream = null;
    }
  }

  async _warmMic() {
    try {
      this._releaseMic();
      this._micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this._micStream = null;
    }
  }

  _stopListening() {
    this._abortActiveListen();
    this._listenAbort = false;
    this._emit();
  }

  _recorderMime() {
    if (MediaRecorder.isTypeSupported("audio/mp4")) return "audio/mp4";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) return "audio/webm;codecs=opus";
    if (MediaRecorder.isTypeSupported("audio/webm")) return "audio/webm";
    return "";
  }

  async _listenCloud(maxMs = this._listenMs(), { forResume = false } = {}) {
    if (!this.active) return "";
    if (this.paused && !forResume) {
      await this._pausedListenDelay();
      return "";
    }
    this._listenAbort = false;
    this._listening = true;
    this._emit({
      message: forResume ? "Paused — say when you're back" : "Listening…",
    });
    try {
      if (!this._micStream) await this._warmMic();
      if (!this._micStream || this._listenAbort) return "";

      const mime = this._recorderMime();
      const recorder = new MediaRecorder(this._micStream, mime ? { mimeType: mime } : undefined);
      this._mediaRecorder = recorder;
      const chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };

      const blob = await new Promise((resolve, reject) => {
        recorder.onstop = () => {
          this._mediaRecorder = null;
          resolve(new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" }));
        };
        recorder.onerror = () => reject(new Error("record failed"));
        try {
          recorder.start();
        } catch (err) {
          reject(err);
          return;
        }
        this._recordTimer = setTimeout(() => {
          if (recorder.state === "recording") recorder.stop();
        }, maxMs);
      });

      if (this._listenAbort || !blob.size) return "";

      const ext = (recorder.mimeType || mime).includes("mp4") ? "audio.mp4" : "audio.webm";
      const form = new FormData();
      form.append("audio", blob, ext);

      const res = await fetch("/api/cook/transcribe", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok || this._listenAbort) return "";
      const data = await res.json();
      return normalize(data.transcript || "");
    } catch {
      return "";
    } finally {
      if (this._recordTimer) {
        clearTimeout(this._recordTimer);
        this._recordTimer = null;
      }
      this._mediaRecorder = null;
      this._listening = false;
      this._emit();
    }
  }

  _listenBrowser({ forResume = false } = {}) {
    return new Promise((resolve) => {
      if (!this.active || !SpeechRecognition) {
        resolve("");
        return;
      }
      if (this.paused && !forResume) {
        this._pausedListenDelay().then(() => resolve(""));
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
        this._stopHearMonitor();
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

      this._listenAbort = false;
      this._listening = true;
      this._emit({
        message: forResume ? "Paused — say when you're back" : "Listening…",
      });
      this._startHearMonitor();
      try {
        rec.start();
      } catch {
        finish("");
      }
    });
  }

  listen(opts = {}) {
    if (this.useCloudListen) return this._listenCloud(this._listenMs(), opts);
    return this._listenBrowser(opts);
  }

  async _interpretCloud(transcript) {
    if (!needsLlm(transcript)) return null;
    const { servings, unitSystem } = this.getCookState();
    const res = await fetch("/api/cook/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        recipe_id: this.recipe.id,
        transcript,
        phase: this.phase,
        index: this.index,
        servings,
        unit_system: unitSystem,
        session_context: buildSessionContext(this._commandCtx()),
      }),
    });
    if (!res.ok) return null;
    return res.json();
  }

  async _readRemainingIngredients(fromStart = false) {
    const text = formatRemainingIngredients(this._commandCtx(), fromStart);
    const result = await this.speak(text, { interruptible: true });
    if (result?.status === "interrupted") {
      return this._handleInterruptDuringSpeak(result.transcript);
    }
    if (fromStart) this.index = this.visibleIngredients.length;
    return true;
  }

  async _readRemainingSteps(fromStart = false) {
    const text = formatRemainingSteps(this._commandCtx(), fromStart);
    const result = await this.speak(text, { interruptible: true });
    if (result?.status === "interrupted") {
      return this._handleInterruptDuringSpeak(result.transcript);
    }
    return true;
  }

  async _handleInterruptDuringSpeak(transcript) {
    const t = transcript.toLowerCase().trim();
    if (/^(stop|quit|exit|end assistant)$/.test(t)) {
      await this.speak("Stopping.");
      this.stop();
      return "stop";
    }
    if (isInterruptPhrase(transcript)) {
      await this._enterPause("Okay, I'll wait.");
      return "pause";
    }
    return this._handleCommand(transcript);
  }

  async _speakIngredientsBlock() {
    const ings = this.visibleIngredients;
    if (!ings.length) return false;

    const ctx = this._commandCtx();
    const slice = ings.slice(this.index);
    let text;
    if (this.index === 0) {
      text = formatAllIngredients(ctx);
    } else {
      const parts = slice.map((ing) => this.ingredientDisplay(ing));
      text = `Remaining ingredients. ${parts.join(". ")}.`;
    }

    this.onHighlight({ phase: "ingredients", index: this.index });
    this._emit();

    const result = await this.speak(text, { interruptible: true });
    if (result?.status === "interrupted") {
      return this._handleInterruptDuringSpeak(result.transcript);
    }
    this.index = ings.length;
    return true;
  }

  async _finishIngredientsPhase() {
    const msg =
      this._verbosity() === "minimal"
        ? "Ingredients done. Say next for step one."
        : "That's all the ingredients. Say next when you're ready for step one.";
    await this.speak(msg);
    this.phase = "steps";
    this.index = 0;
    this.onHighlight({ phase: "steps", index: 0 });
    this._emit();
  }

  async _applyLocalCommand(cmd) {
    if (cmd.clientOnly && cmd.action === "print") {
      if (this.onPrint) this.onPrint();
      await this.speak("Printing.");
      return true;
    }
    if (cmd.servings != null) this.setServings(cmd.servings);
    if (cmd.unit_system && this.setUnitSystem) this.setUnitSystem(cmd.unit_system);
    if (cmd.phase) this.phase = cmd.phase;
    if (cmd.index != null) this.index = cmd.index;

    switch (cmd.action) {
      case "next":
        this.index++;
        await this._presentCurrent(false);
        return true;
      case "back":
        if (this.index > 0) this.index--;
        await this._presentCurrent(false);
        return true;
      case "repeat":
        await this._presentCurrent(false);
        return true;
      case "stop":
        await this.speak(cmd.speech || "Stopping.");
        this.stop();
        return "stop";
      case "pause":
        await this._enterPause(cmd.speech);
        return "pause";
      case "resume":
        return await this._exitPause(cmd.speech);
      case "help":
        await this.speak(cmd.speech || COMMAND_HELP);
        return true;
      case "goto":
        await this.speak(cmd.speech || "");
        await this._presentCurrent(!cmd.speech);
        return true;
      case "read_remaining_ingredients":
        return this._readRemainingIngredients(false);
      case "read_remaining_steps":
        return this._readRemainingSteps(false);
      case "read_all_ingredients":
        return this._readRemainingIngredients(true);
      case "read_all_steps":
        return this._readRemainingSteps(true);
      case "answer":
        if (cmd.speech) await this.speak(cmd.speech);
        return true;
      default:
        return false;
    }
  }

  _matchCustomCommand(t) {
    for (const cmd of this.settings.custom_commands || []) {
      for (const phrase of cmd.phrases || []) {
        const p = normalize(phrase);
        if (p && t.includes(p)) return cmd;
      }
    }
    return null;
  }

  async _applyCustomCommand(cmd) {
    const res = {
      action: cmd.action || "answer",
      speech: cmd.speech || "",
      servings: null,
      unit_system: null,
      phase: null,
      index: null,
    };
    return this._applyVoiceResult(res);
  }

  async _applyVoiceResult(res) {
    if (res.servings != null) this.setServings(res.servings);
    if (res.unit_system && this.setUnitSystem) this.setUnitSystem(res.unit_system);
    if (res.phase) this.phase = res.phase;
    if (res.index != null) this.index = res.index;

    const say = async (text) => {
      if (text?.trim()) await this.speak(text);
    };

    switch (res.action) {
      case "stop":
        await say(res.speech);
        this.stop();
        return "stop";
      case "pause":
        await this._enterPause(res.speech);
        return "pause";
      case "resume":
        return await this._exitPause(res.speech);
      case "help":
        await say(
          res.speech ||
            "Say next, repeat, or back. Ask read remaining ingredients. Say pause or stop."
        );
        return true;
      case "repeat":
        await say(res.speech);
        await this._presentCurrent(false);
        return true;
      case "read_remaining_ingredients":
        await say(res.speech);
        return this._readRemainingIngredients(false);
      case "read_remaining_steps":
        await say(res.speech);
        return this._readRemainingSteps(false);
      case "read_all_ingredients":
        await say(res.speech);
        return this._readRemainingIngredients(true);
      case "read_all_steps":
        await say(res.speech);
        return this._readRemainingSteps(true);
      case "back":
        if (res.index == null && this.index > 0) this.index--;
        await say(res.speech);
        await this._presentCurrent(!res.speech);
        return true;
      case "next":
        if (res.index == null) this.index++;
        await say(res.speech);
        await this._presentCurrent(!res.speech);
        return true;
      case "goto_ingredients":
        this.phase = "ingredients";
        if (res.index == null) this.index = 0;
        await say(res.speech);
        await this._presentCurrent(!res.speech);
        return true;
      case "goto_steps":
        this.phase = "steps";
        if (res.index == null) this.index = 0;
        await say(res.speech);
        await this._presentCurrent(!res.speech);
        return true;
      case "print_recipe":
        if (this.onPrint) this.onPrint();
        await say(res.speech || "Printing.");
        return true;
      case "goto":
        if (res.phase) this.phase = res.phase;
        if (res.index != null) this.index = res.index;
        await say(res.speech);
        await this._presentCurrent(!res.speech);
        return true;
      case "answer":
        await say(res.speech);
        return true;
      case "noop":
        if (res.speech) await say(res.speech);
        return !!res.speech;
      default:
        return false;
    }
  }

  async _enterPause(speech) {
    this.paused = true;
    this._speakTicket += 1;
    this._stopInterruptListen();
    this._abortActiveListen();
    this._haltSpeechPlayback();
    this._emit({ message: "Paused — say when you're back" });
    if (speech?.trim()) await this.speak(speech);
  }

  async _exitPause(speech) {
    if (!this.paused) return "resume";
    this.paused = false;
    this._listenAbort = false;
    this._emit();
    try {
      if (speech?.trim()) await this.speak(speech);
      if (this.active) await this._speakCurrentItem(false);
    } catch {
      /* keep loop alive after audio errors */
    }
    return "resume";
  }

  async _speakCurrentItem(intro = true) {
    if (!this.active || this.paused) return;
    const ings = this.visibleIngredients;
    const steps = this.instructions;

    if (this.phase === "ingredients") {
      if (!ings.length) {
        this.phase = "steps";
        this.index = 0;
        return this._speakCurrentItem(intro);
      }
      if (this.index >= ings.length) {
        return this._finishIngredientsPhase();
      }
      const handled = await this._speakIngredientsBlock();
      if (handled === "stop" || handled === "pause") return handled;
      if (handled !== true) return;
      return this._finishIngredientsPhase();
    }

    const suffix = this._promptSuffix();
    if (this.index >= steps.length) {
      await this.speak(`You're done. Enjoy your ${this.recipe.title}.`);
      this.stop();
      return;
    }
    const step = steps[this.index];
    this.onHighlight({ phase: "steps", index: this.index });
    this._emit();
    const announce = intro && this._verbosity() !== "minimal";
    const line = this._stepLine(step, this.index + 1, steps.length, announce) + suffix;
    const result = await this.speak(line, { interruptible: true });
    if (result?.status === "interrupted") {
      return this._handleInterruptDuringSpeak(result.transcript);
    }
  }

  async _loopListen() {
    if (this.settings.push_to_talk || this._loopRunning) return;
    this._loopRunning = true;
    try {
      while (this.active) {
        const transcript = await this.listen({ forResume: this.paused });
        if (!this.active) break;
        if (!transcript) {
          if (this.paused) this._emit({ message: "Paused — say when you're back" });
          continue;
        }
        if (this.paused) {
          if (isResumePhrase(transcript) || /\b(help|stop|quit)\b/.test(transcript)) {
            try {
              const handled = await this._handleCommand(transcript);
              if (handled === "stop") break;
            } catch {
              /* don't break the listen loop on command errors */
            }
          }
          continue;
        }
        try {
          const handled = await this._handleCommand(transcript);
          if (handled === "stop") break;
          if (handled === "pause") continue;
          if (!handled && this._verbosity() !== "minimal") {
            await this.speak("Say next, repeat, or help.");
          }
        } catch {
          /* keep listening after unexpected errors */
        }
      }
    } finally {
      this._loopRunning = false;
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
        return this._finishIngredientsPhase();
      }
      const handled = await this._speakIngredientsBlock();
      if (handled === "stop" || handled === "pause") return handled;
      if (handled !== true) return;
      return this._finishIngredientsPhase();
    }

    const suffix = this._promptSuffix();
    if (this.index >= steps.length) {
      await this.speak(`You're done. Enjoy your ${this.recipe.title}.`);
      this.stop();
      return;
    }
    const step = steps[this.index];
    this.onHighlight({ phase: "steps", index: this.index });
    this._emit();
    const announce = intro && this._verbosity() !== "minimal";
    const line = this._stepLine(step, this.index + 1, steps.length, announce) + suffix;
    const result = await this.speak(line, { interruptible: true });
    if (result?.status === "interrupted") {
      return this._handleInterruptDuringSpeak(result.transcript);
    }
  }

  async _handleCommand(transcript) {
    const custom = this._matchCustomCommand(transcript);
    if (custom) return this._applyCustomCommand(custom);

    const local = matchLocalCommand(transcript, this._commandCtx());
    if (local) return this._applyLocalCommand(local);

    const t = transcript;
    const tempAnswer = this._answerTemperature(t);
    if (tempAnswer) {
      await this.speak(tempAnswer);
      return true;
    }
    const basicsAnswer = tryCookingBasicsAnswer(t);
    if (basicsAnswer) {
      await this.speak(basicsAnswer);
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

    if (!this.useCloudInterpret || !needsLlm(transcript)) return false;

    try {
      const result = await this._interpretCloud(transcript);
      if (!result || (result.action === "noop" && !result.speech)) {
        if (needsLlm(transcript)) {
          await this.speak(
            "I'm not sure about that — try rephrasing, or ask about this recipe's ingredients or steps."
          );
          return true;
        }
        return false;
      }
      return this._applyVoiceResult(result);
    } catch {
      return false;
    }
  }

  _currentIngredientAmount() {
    if (this.phase !== "ingredients") return null;
    const ing = this.visibleIngredients[this.index];
    if (!ing) return null;
    return `${this.ingredientDisplay(ing)}.`;
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
    const parts = [this.recipe.notes || "", ...this.instructions.map((s) => s.text)];
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
    return `Temperatures: ${unique.join(", ")}.`;
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
        return `${ctx}.`;
      }
    }
    if (/\brefrigerat/i.test(transcript)) {
      return "No refrigerate time listed. Check the notes.";
    }
    return null;
  }
}

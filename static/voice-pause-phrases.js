/**
 * Natural phrases for pausing / resuming the cook assistant (phone call, interruption, etc.).
 */

function norm(t) {
  return t
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Phrases that mean "stop listening for now" — checked when not paused. */
const PAUSE_PATTERNS = [
  /^pause$/,
  /^wait$/,
  /^hold$/,
  /^stop listening$/,
  /\bhold on\b/,
  /\bhang on\b/,
  /\bhold up\b/,
  /\bplease hold\b/,
  /\bhold please\b/,
  /\bplease wait\b/,
  /\bwait please\b/,
  /\bwait up\b/,
  /\bwait a (sec|second|minute|moment)\b/,
  /\b(one|a) (sec|second|minute|moment)\b/,
  /\b(give|gimme) me a (sec|second|minute|moment)\b/,
  /\b(be|need) a (minute|second|moment)\b/,
  /\bjust a (sec|second|minute|moment)\b/,
  /\bstand by\b/,
  /\bstandby\b/,
  /\bhold everything\b/,
  /\bstop for a (sec|second|minute)\b/,
  /\bphone call\b/,
  /\bgot a call\b/,
  /\bsomeone (is |'?s )?at the door\b/,
  /\bnot (right )?now\b/,
  /\bcan you wait\b/,
  /\bi need (a minute|to pause|a second)\b/,
  /\blet me pause\b/,
];

/** Phrases that mean "start listening again" — checked when paused. */
const RESUME_PATTERNS = [
  /^resume$/,
  /^unpause$/,
  /^continue$/,
  /\bi am back\b/,
  /\bi'?m back\b/,
  /\bback now\b/,
  /\bbegin again\b/,
  /\bstart again\b/,
  /\bstart back up\b/,
  /\bstart (it )?back up\b/,
  /\bstart listening\b/,
  /\bplease listen\b/,
  /\bpick (it )?back up\b/,
  /\bpick up where we left off\b/,
  /\bwhere were we\b/,
  /\bok i'?m ready\b/,
  /\bokay i'?m ready\b/,
  /\balright i'?m ready\b/,
  /\ball right i'?m ready\b/,
  /\blet'?s go\b/,
  /\blet'?s continue\b/,
  /\blet'?s pick up\b/,
  /\bwe can continue\b/,
  /\bready when you are\b/,
  /\byou can continue\b/,
  /\bkeep going\b/,
  /\bcarry on\b/,
  /\bgo ahead\b/,
  /\bback to the recipe\b/,
];

/** Short affirmations count as resume only while paused. */
const RESUME_SHORT = /^(ok|okay|yes|ready|alright|all right|go|continue)$/;

export function isPausePhrase(transcript) {
  const t = norm(transcript);
  if (!t) return false;
  return PAUSE_PATTERNS.some((re) => re.test(t));
}

/** While the assistant is speaking — stop the readout (not necessarily quit cook mode). */
const INTERRUPT_PATTERNS = [
  /^stop$/,
  /^wait$/,
  /^hold$/,
  /\bstop reading\b/,
  /\bstop listing\b/,
  /\bthat'?s enough\b/,
  /\benough\b/,
  /\bskip (that|it|this)\b/,
  /\bhold on\b/,
  /\bhang on\b/,
  /\bhold up\b/,
  /\bplease hold\b/,
  /\bplease wait\b/,
  /\bwait up\b/,
  /\b(give|gimme) me a (sec|second|minute|moment)\b/,
  /\bstand by\b/,
  /\bstandby\b/,
  /\bcan you wait\b/,
  /\bnot (right )?now\b/,
];

export function isInterruptPhrase(transcript) {
  const t = norm(transcript);
  if (!t) return false;
  if (isPausePhrase(transcript)) return true;
  return INTERRUPT_PATTERNS.some((re) => re.test(t));
}

export function isResumePhrase(transcript) {
  const t = norm(transcript);
  if (!t) return false;
  if (RESUME_SHORT.test(t)) return true;
  return RESUME_PATTERNS.some((re) => re.test(t));
}

export const PAUSE_HINT = "Say hold on or wait to pause; say I'm back or let's go to resume.";
export const PAUSE_ACK = "Okay, I'll wait.";
export const RESUME_ACK = "Welcome back.";

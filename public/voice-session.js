export function shouldForwardCapturedAudio({ muted, pttMode, pttHeld, assistantSpeaking }) {
  if (muted) return false;
  if (pttMode) return pttHeld;
  return !assistantSpeaking;
}

export function createIdleCallTimer({ now = () => Date.now() } = {}) {
  let active = false;
  let lastActivity = 0;
  let warnedAt = null;
  const activity = () => { lastActivity = now(); warnedAt = null; };
  return {
    start() { active = true; activity(); },
    stop() { active = false; warnedAt = null; },
    activity,
    tick({ enabled = true, warningSeconds = 40, endSeconds = 60, busy = false } = {}) {
      if (!active) return null;
      if (!enabled) { activity(); return null; }
      if (busy) { if (warnedAt === null) lastActivity = now(); return null; }
      const elapsed = now() - lastActivity;
      if (warnedAt === null && elapsed >= warningSeconds * 1000) {
        warnedAt = now();
        return 'warn';
      }
      if (warnedAt !== null && elapsed >= endSeconds * 1000 && now() - warnedAt >= (endSeconds - warningSeconds) * 1000) {
        active = false;
        return 'end';
      }
      return null;
    },
  };
}
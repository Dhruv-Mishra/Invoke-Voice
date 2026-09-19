export function shouldForwardCapturedAudio({ muted, pttMode, pttHeld, assistantSpeaking }) {
  if (muted) return false;
  if (pttMode) return pttHeld;
  return !assistantSpeaking;
}

export function createIdleCallTimer({ now = () => Date.now() } = {}) {
  let active = false;
  let lastActivity = 0;
  const activity = () => { lastActivity = now(); };
  return {
    start() { active = true; activity(); },
    stop() { active = false; },
    activity,
    tick({ enabled = true, endSeconds = 60, busy = false } = {}) {
      if (!active) return null;
      if (!enabled || busy) { activity(); return null; }
      if (now() - lastActivity >= endSeconds * 1000) {
        active = false;
        return 'end';
      }
      return null;
    },
  };
}
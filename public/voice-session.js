export function shouldForwardCapturedAudio({ muted, pttMode, pttHeld, assistantSpeaking }) {
  if (muted) return false;
  if (pttMode) return pttHeld;
  return !assistantSpeaking;
}
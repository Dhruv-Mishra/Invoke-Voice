export function createVoiceCaptionBridge({ conversationUI, partialTranscript, appendMessage }) {
  function hidePartialTranscript() {
    partialTranscript.hidden = true;
    partialTranscript.textContent = '';
  }

  return {
    transcript({ role = 'assistant', text, partial = false }) {
      if (partial) {
        partialTranscript.hidden = false;
        partialTranscript.textContent = `${role}: ${text}...`;
        conversationUI.preview(role, text);
        return;
      }
      hidePartialTranscript();
      appendMessage(role, text);
    },
    clear() {
      conversationUI.clearCaption();
      hidePartialTranscript();
    },
    reset() {
      conversationUI.clear();
      hidePartialTranscript();
    },
  };
}
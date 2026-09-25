export function createVoiceCaptionBridge({ conversationUI, partialTranscript, appendMessage }) {
  let spokenResponseId;
  let spokenText = '';
  function hidePartialTranscript() {
    partialTranscript.hidden = true;
    partialTranscript.textContent = '';
  }

  return {
    // audioCaptions transcripts stay in chat; their caption follows playback via spoken().
    transcript({ role = 'assistant', text, partial = false, audioCaptions = false }) {
      if (partial) {
        partialTranscript.hidden = false;
        partialTranscript.textContent = `${role}: ${text}...`;
        if (!audioCaptions) conversationUI.preview(role, text);
        return;
      }
      hidePartialTranscript();
      appendMessage(role, text, audioCaptions ? { caption: false } : undefined);
    },
    spoken(responseId, text) {
      spokenText = spokenResponseId === responseId ? `${spokenText} ${text}` : text;
      spokenResponseId = responseId;
      conversationUI.preview('assistant', spokenText);
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
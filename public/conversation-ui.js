export function createCaptionController(render, timers = globalThis) {
  let current = null;
  let timeout;
  let revision = 0;
  let paused = false;

  function cancelExpiry() {
    timers.clearTimeout(timeout);
    revision++;
  }

  function clear() {
    cancelExpiry();
    current = null;
    render(null);
  }

  function scheduleExpiry() {
    cancelExpiry();
    if (!current || paused) return;
    const scheduledRevision = revision;
    timeout = timers.setTimeout(() => {
      if (scheduledRevision === revision) clear();
    }, Math.min(16000, 6000 + current.text.length * 40));
  }

  return {
    update(role, text, partial = false) {
      if (!['user', 'assistant'].includes(role) || typeof text !== 'string' || !text.trim()) return;
      const clean = text.trim();
      const display = clean.length > 280 ? `...${clean.slice(-277)}` : clean;
      current = { role, text: display, partial: Boolean(partial) };
      render(current);
      scheduleExpiry();
    },
    clear,
    pause(value) {
      paused = Boolean(value);
      scheduleExpiry();
    },
  };
}

export function createConversationUI(document, openConversation) {
  const history = document.getElementById('chat-history');
  const empty = document.getElementById('history-empty');
  const caption = document.getElementById('closed-caption');
  const speaker = document.getElementById('caption-speaker');
  const text = document.getElementById('caption-text');
  const announcement = document.getElementById('caption-announcement');
  const captions = createCaptionController(value => {
    caption.hidden = !value;
    text.textContent = value?.text || '';
    speaker.textContent = value?.role === 'user' ? 'You' : 'Supervisor';
    caption.dataset.role = value?.role || '';
    announcement.textContent = value && !value.partial && !document.getElementById('conversation-dialog').open
      ? `${speaker.textContent}: ${value.text}` : '';
  });
  const syncPause = () => captions.pause(caption.matches(':hover') || caption.contains(document.activeElement));
  for (const event of ['pointerenter', 'pointerleave', 'focusin']) caption.addEventListener(event, syncPause);
  caption.addEventListener('focusout', event => captions.pause(caption.matches(':hover') || caption.contains(event.relatedTarget)));
  document.getElementById('dismiss-caption-btn').addEventListener('click', () => {
    document.getElementById('open-chat-btn').focus();
    captions.clear();
  });
  document.getElementById('history-compose-btn').addEventListener('click', () => openConversation());
  document.defaultView.addEventListener('pagehide', () => captions.clear());

  return {
    preview: (role, content) => captions.update(role, content, true),
    clearCaption: () => captions.clear(),
    message(role, content, bubble) {
      if (!['user', 'assistant'].includes(role) || typeof content !== 'string' || !content.trim()) return;
      captions.update(role, content);
      const item = document.createElement('div');
      item.setAttribute('role', 'listitem');
      const button = document.createElement('button');
      button.className = 'history-entry';
      button.type = 'button';
      const label = document.createElement('strong');
      label.textContent = role === 'user' ? 'You' : 'Supervisor';
      const preview = document.createElement('span');
      preview.textContent = content.length > 160 ? `${content.slice(0, 157)}...` : content;
      button.append(label, preview);
      button.addEventListener('click', () => {
        openConversation();
        bubble.tabIndex = -1;
        bubble.focus({ preventScroll: true });
        bubble.scrollIntoView({ block: 'center', behavior: 'instant' });
      });
      item.append(button);
      history.prepend(item);
      if (history.children.length > 80) history.lastElementChild.remove();
      empty.hidden = true;
    },
    clear() {
      captions.clear();
      history.replaceChildren();
      empty.hidden = false;
    },
  };
}
import { captionTiming } from './themes.js';

export function createCaptionController(render, timers = globalThis) {
  let current = null;
  let timeout;
  let revision = 0;
  let paused = false;
  let expiryDelay;

  function cancelExpiry() {
    timers.clearTimeout(timeout);
    revision++;
  }

  function clear() {
    cancelExpiry();
    paused = false;
    expiryDelay = undefined;
    current = null;
    render(null);
  }

  function scheduleExpiry(delay = expiryDelay) {
    cancelExpiry();
    if (Number.isFinite(delay)) expiryDelay = delay;
    if (!current || paused) return;
    const scheduledRevision = revision;
    timeout = timers.setTimeout(() => {
      if (scheduledRevision !== revision) return;
      current = { ...current, fading: true };
      render(current);
      timeout = timers.setTimeout(() => {
        if (scheduledRevision === revision) clear();
      }, captionTiming.fade);
    }, expiryDelay);
  }

  return {
    update(role, text, partial = false) {
      if (!['user', 'assistant'].includes(role) || typeof text !== 'string' || !text.trim()) return;
      current = { role, text: text.trim(), partial: Boolean(partial) };
      render(current);
      scheduleExpiry(Math.min(captionTiming.maximum, captionTiming.minimum + current.text.length * captionTiming.perCharacter));
    },
    finish: () => scheduleExpiry(captionTiming.afterSpeech),
    clear,
    pause(value) {
      paused = Boolean(value);
      if (paused && current?.fading) {
        current = { ...current, fading: false };
        render(current);
      }
      scheduleExpiry();
    },
  };
}

export function createConversationUI(document) {
  const region = document.querySelector('.caption-region');
  const home = region.parentElement;
  const announcement = document.getElementById('caption-announcement');
  const captions = new Map();
  const fit = content => {
    const text = content.parentElement;
    const caption = text.closest('.closed-caption');
    const captionStyle = document.defaultView.getComputedStyle(caption);
    const textStyle = document.defaultView.getComputedStyle(text);
    const chromeWidth = parseFloat(captionStyle.paddingLeft) + parseFloat(captionStyle.paddingRight)
      + parseFloat(captionStyle.borderLeftWidth) + parseFloat(captionStyle.borderRightWidth)
      + parseFloat(textStyle.paddingLeft) + parseFloat(textStyle.paddingRight);
    const minimumWidth = parseFloat(captionStyle.minWidth);
    const maximumWidth = region.getBoundingClientRect().width - parseFloat(captionStyle.getPropertyValue('--cp-caption-speaker-offset'));
    content.style.whiteSpace = 'nowrap';
    const intrinsicWidth = content.scrollWidth;
    content.style.whiteSpace = '';
    caption.style.width = `${Math.min(maximumWidth, Math.max(minimumWidth, Math.ceil(intrinsicWidth + chromeWidth)))}px`;
    text.style.height = 'auto';
    const maximumHeight = parseFloat(document.defaultView.getComputedStyle(text).maxHeight);
    text.style.height = `${Math.min(content.getBoundingClientRect().height, maximumHeight)}px`;
  };
  document.defaultView.addEventListener('resize', () => {
    for (const content of region.querySelectorAll('.caption-content')) fit(content);
  });
  for (const caption of region.querySelectorAll('.closed-caption')) {
    const role = caption.dataset.role;
    const content = caption.querySelector('.caption-content');
    const speaker = caption.querySelector('.caption-speaker');
    const controller = createCaptionController(value => {
      caption.hidden = !value;
      caption.dataset.fading = String(Boolean(value?.fading));
      if (content.textContent !== (value?.text || '')) {
        content.textContent = value?.text || '';
        if (value) fit(content);
      }
      if (value && !value.partial && !value.fading && !document.getElementById('conversation-dialog').open) {
        announcement.textContent = `${speaker.textContent}: ${value.text}`;
      }
    });
    captions.set(role, controller);
    const syncPause = () => controller.pause(caption.matches(':hover') || caption.contains(document.activeElement));
    for (const event of ['pointerenter', 'pointerleave', 'focusin']) caption.addEventListener(event, syncPause);
    caption.addEventListener('focusout', event => controller.pause(caption.matches(':hover') || caption.contains(event.relatedTarget)));
    caption.querySelector('button').addEventListener('click', () => {
      const target = caption.closest('dialog')?.querySelector('button') || document.getElementById('open-chat-btn');
      target.focus({ preventScroll: true });
      controller.clear();
    });
  }
  document.addEventListener('toggle', event => {
    if (event.target.tagName !== 'DIALOG') return;
    const host = [...document.querySelectorAll('dialog:modal')].at(-1) || home;
    if (region.parentElement !== host) host.append(region);
  }, true);
  const clear = () => {
    for (const controller of captions.values()) controller.clear();
    announcement.textContent = '';
  };
  document.defaultView.addEventListener('pagehide', () => {
    clear();
  });

  return {
    preview: (role, content) => captions.get(role)?.update(role, content, true),
    clearCaption: clear,
    finishCaption: role => captions.get(role)?.finish(),
    message(role, content) {
      captions.get(role)?.update(role, content);
    },
    clear,
  };
}
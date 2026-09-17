const controls = new WeakMap();

export function refreshPillbars(root = document) {
  let changed = false;
  for (const select of root.querySelectorAll('select[data-pillbar]')) {
    let entry = controls.get(select);
    if (!entry) {
      const bar = document.createElement('div');
      bar.className = 'pillbar';
      bar.setAttribute('role', 'radiogroup');
      bar.setAttribute('aria-label', select.getAttribute('aria-label') || select.labels?.[0]?.textContent || 'Options');
      bar.dataset.for = select.id;
      select.hidden = true;
      select.after(bar);
      entry = { bar, signature: '' };
      controls.set(select, entry);
      bar.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button || button.disabled || button.value === select.value) return;
        select.value = button.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        refreshPillbars();
        entry.bar.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
      });
      bar.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...bar.querySelectorAll('button:not(:disabled)')];
        const current = buttons.indexOf(document.activeElement);
        if (current < 0) return;
        event.preventDefault();
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length;
        buttons[index]?.click();
      });
    }
    const signature = JSON.stringify([select.value, select.disabled, [...select.options].map(option => [option.value, option.textContent, option.disabled])]);
    if (entry.signature === signature) continue;
    changed = true;
    entry.signature = signature;
    const focus = entry.bar.contains(document.activeElement);
    entry.bar.replaceChildren(...[...select.options].map(option => {
      const button = document.createElement('button');
      button.type = 'button';
      button.value = option.value;
      button.disabled = select.disabled || option.disabled;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(option.value === select.value));
      button.tabIndex = option.value === select.value ? 0 : -1;
      button.title = option.textContent;
      if (select.dataset.providerIcons !== undefined) {
        const glyph = document.createElement('i');
        glyph.dataset.lucide = ['local', 'whisper', 'moonshine'].includes(option.value) ? 'folder' : 'app-window';
        glyph.setAttribute('aria-hidden', 'true');
        button.append(glyph);
      }
      const text = document.createElement('span');
      text.textContent = option.textContent;
      button.append(text);
      return button;
    }));
    if (focus) entry.bar.querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
  }
  if (changed) window.lucide?.createIcons();
}
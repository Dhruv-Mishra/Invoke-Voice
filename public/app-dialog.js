export function createAppDialog(dialog) {
  const title = dialog.querySelector('[data-app-dialog-title]');
  const message = dialog.querySelector('[data-app-dialog-message]');
  const cancel = dialog.querySelector('[data-app-dialog-cancel]');
  const accept = dialog.querySelector('[data-app-dialog-accept]');
  let queue = Promise.resolve();

  function show({ heading, text, acceptLabel, cancelLabel = '', danger = false }) {
    return new Promise(resolve => {
      title.textContent = heading;
      message.textContent = text;
      accept.textContent = acceptLabel;
      cancel.textContent = cancelLabel;
      cancel.hidden = !cancelLabel;
      accept.classList.toggle('btn-accent', !danger);
      accept.classList.toggle('btn-danger', danger);
      dialog.returnValue = 'cancel';
      const onClose = () => resolve(dialog.returnValue === 'confirm');
      dialog.addEventListener('close', onClose, { once: true });
      dialog.showModal();
      accept.focus({ preventScroll: true });
    });
  }

  function enqueue(options) {
    const result = queue.then(() => show(options));
    queue = result.then(() => undefined);
    return result;
  }

  return {
    alert(text, heading = 'Notice') {
      return enqueue({ heading, text, acceptLabel: 'OK' });
    },
    confirm(text, { heading = 'Confirm', acceptLabel = 'Continue', danger = false } = {}) {
      return enqueue({ heading, text, acceptLabel, cancelLabel: 'Cancel', danger });
    },
  };
}
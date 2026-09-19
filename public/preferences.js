export function readPreference(key) {
  try {
    const desktop = window.voiceSupervisorPreferences;
    const saved = desktop?.getItem(key);
    if (saved != null) return saved;
    const legacy = localStorage.getItem(key);
    if (desktop && legacy !== null) desktop.setItem(key, legacy);
    return legacy;
  } catch (error) {
    console.warn('Could not restore an application preference.', error);
    return null;
  }
}

export function savePreference(key, value) {
  try {
    (window.voiceSupervisorPreferences || localStorage).setItem(key, value);
  } catch (error) {
    console.warn('Could not save an application preference.', error);
  }
}
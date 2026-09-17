const presets = new Map([
  ['jarvis', Object.freeze({
    instruction: 'Use a precise, composed technical tone with dry wit; stay brief.',
    openai: 'cedar', gemini: 'Charon', kokoro: 'am_michael', speed: 1.08, pitch: 0.94,
  })],
  ['baymax', Object.freeze({
    instruction: 'Use a gentle, reassuring, matter-of-fact tone; stay brief.',
    openai: 'marin', gemini: 'Achird', kokoro: 'am_fenrir', speed: 1.02, pitch: 0.9,
  })],
]);

export function sessionThemeOptions(input = {}) {
  const id = presets.has(input?.theme) ? input.theme : '';
  return { persona: input?.themePersona === true ? id : '', voiceTheme: input?.themeVoice === true ? id : '' };
}

export function themedInstructions(base, persona) {
  const addition = presets.get(persona)?.instruction;
  return addition ? `${base} ${addition}` : base;
}

export function themeVoicePreset(id) {
  return presets.get(id) || null;
}
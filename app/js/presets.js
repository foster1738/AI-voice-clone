// Voice presets. Every field not given falls back to DEFAULTS.
//
// Presets with `targetF0` are "smart": once the app has learned your natural
// pitch (Voice Match), the pitch shift is computed so that *your* voice lands
// on the target, and the formant shift follows by `formantFollow` semitones per
// semitone of pitch. Without calibration the fixed `pitch`/`formant` are used.

export const DEFAULTS = {
  pitch: 0,
  formant: 0,
  mode: 'normal',
  robotHz: 110,
  tuneKey: 0,
  tuneScale: 'chromatic',
  whisper: 0,
  crushBits: 0,
  crushDown: 1,
  drive: 0,
  ringHz: 30,
  ringMix: 0,
  chorusMix: 0,
  chorusRate: 0.8,
  chorusDepth: 3,
  chorusDelay: 15,
  chorusFeedback: 0,
  echoMix: 0,
  echoTime: 0.28,
  echoFeedback: 0.35,
  reverbMix: 0,
  reverbDecay: 2,
  bass: 0,
  mid: 0,
  midHz: 1500,
  treble: 0,
  filter: 'none',
  volume: 1,
};

export const PRESETS = [
  { id: 'natural', name: 'Natural', icon: '🎙️', cat: 'Everyday', params: {} },
  { id: 'deep', name: 'Deep Voice', icon: '🧔', cat: 'Everyday', targetF0: 95, formantFollow: 0.45, params: { pitch: -5, formant: -2, bass: 3 } },
  { id: 'feminine', name: 'Feminine', icon: '👩', cat: 'Everyday', targetF0: 215, formantFollow: 0.4, params: { pitch: 5, formant: 2.5, treble: 2 } },
  { id: 'masculine', name: 'Masculine', icon: '👨', cat: 'Everyday', targetF0: 115, formantFollow: 0.4, params: { pitch: -5, formant: -2.5, bass: 2 } },
  { id: 'child', name: 'Child', icon: '🧒', cat: 'Everyday', targetF0: 290, formantFollow: 0.5, params: { pitch: 7, formant: 4 } },
  { id: 'elder', name: 'Elder', icon: '👴', cat: 'Everyday', params: { pitch: -2, formant: -0.5, chorusMix: 0.35, chorusRate: 5.5, chorusDepth: 1.2, chorusDelay: 6, treble: -2 } },
  { id: 'chipmunk', name: 'Chipmunk', icon: '🐿️', cat: 'Fun', params: { pitch: 10, formant: 6 } },
  { id: 'helium', name: 'Helium', icon: '🎈', cat: 'Fun', params: { pitch: 2, formant: 7 } },
  { id: 'giant', name: 'Giant', icon: '🗿', cat: 'Fun', targetF0: 60, formantFollow: 0.6, params: { pitch: -10, formant: -6, bass: 4, reverbMix: 0.25, reverbDecay: 3 } },
  { id: 'drunk', name: 'Tipsy', icon: '🥴', cat: 'Fun', params: { pitch: -1, chorusMix: 0.8, chorusRate: 0.35, chorusDepth: 9, chorusDelay: 20 } },
  { id: 'robot', name: 'Robot', icon: '🤖', cat: 'Sci-Fi', params: { mode: 'robot', robotHz: 110, ringHz: 50, ringMix: 0.25, chorusMix: 0.3, chorusDelay: 8, chorusDepth: 0.4, chorusFeedback: 0.5 } },
  { id: 'cyborg', name: 'Cyborg', icon: '🦾', cat: 'Sci-Fi', params: { pitch: -3, formant: -1, crushBits: 8, crushDown: 2, ringHz: 90, ringMix: 0.35, mid: 4, midHz: 2000, reverbMix: 0.15, reverbDecay: 0.8 } },
  { id: 'alien', name: 'Alien', icon: '👽', cat: 'Sci-Fi', params: { pitch: 4, formant: -4, ringHz: 38, ringMix: 0.6, chorusMix: 0.5, chorusRate: 3, chorusDepth: 2, echoMix: 0.2, echoTime: 0.12 } },
  { id: 'villain', name: 'Dark Lord', icon: '🦹', cat: 'Sci-Fi', params: { pitch: -7, formant: -3, drive: 0.25, bass: 5, filter: 'mask', reverbMix: 0.2, reverbDecay: 1.2 } },
  { id: 'bits', name: '8-Bit', icon: '👾', cat: 'Sci-Fi', params: { mode: 'tune', crushBits: 5, crushDown: 6, pitch: 3 } },
  { id: 'monster', name: 'Monster', icon: '👹', cat: 'Horror', params: { pitch: -11, formant: -7, drive: 0.45, bass: 6, reverbMix: 0.3, reverbDecay: 2.5 } },
  { id: 'demon', name: 'Demon', icon: '😈', cat: 'Horror', params: { pitch: -9, formant: -2, ringHz: 18, ringMix: 0.35, drive: 0.35, reverbMix: 0.45, reverbDecay: 4, echoMix: 0.15 } },
  { id: 'ghost', name: 'Ghost', icon: '👻', cat: 'Horror', params: { pitch: 2, whisper: 0.85, chorusMix: 0.5, chorusRate: 0.3, chorusDepth: 6, reverbMix: 0.6, reverbDecay: 5, bass: -6 } },
  { id: 'whisper', name: 'Whisper', icon: '🤫', cat: 'Horror', params: { whisper: 1, bass: -8, treble: 3 } },
  { id: 'tune', name: 'Hard Tune', icon: '🎤', cat: 'Music', params: { mode: 'tune', tuneScale: 'major', reverbMix: 0.15, reverbDecay: 1.5 } },
  { id: 'harmony', name: 'Pop Star', icon: '🌟', cat: 'Music', params: { mode: 'tune', tuneScale: 'chromatic', pitch: 2, formant: 1, chorusMix: 0.35, echoMix: 0.18, echoTime: 0.22, reverbMix: 0.25 } },
  { id: 'radio', name: 'Radio', icon: '📻', cat: 'Places', params: { filter: 'radio', drive: 0.2, mid: 3 } },
  { id: 'phone', name: 'Telephone', icon: '☎️', cat: 'Places', params: { filter: 'telephone', drive: 0.1 } },
  { id: 'walkie', name: 'Walkie-Talkie', icon: '📡', cat: 'Places', params: { filter: 'telephone', drive: 0.55, crushBits: 7, crushDown: 3 } },
  { id: 'megaphone', name: 'Megaphone', icon: '📢', cat: 'Places', params: { filter: 'megaphone', drive: 0.6, echoMix: 0.12, echoTime: 0.18 } },
  { id: 'underwater', name: 'Underwater', icon: '🌊', cat: 'Places', params: { filter: 'underwater', chorusMix: 0.7, chorusRate: 0.6, chorusDepth: 5, reverbMix: 0.3 } },
  { id: 'cave', name: 'Cave', icon: '🕳️', cat: 'Places', params: { echoMix: 0.35, echoTime: 0.33, echoFeedback: 0.45, reverbMix: 0.4, reverbDecay: 3 } },
  { id: 'cathedral', name: 'Cathedral', icon: '⛪', cat: 'Places', params: { reverbMix: 0.55, reverbDecay: 6, treble: -2 } },
  { id: 'stadium', name: 'Stadium', icon: '🏟️', cat: 'Places', params: { filter: 'megaphone', echoMix: 0.3, echoTime: 0.45, echoFeedback: 0.3, reverbMix: 0.35, reverbDecay: 3.5 } },
];

/** Resolve a preset (plus optional user overrides) into concrete engine params. */
export function resolveParams(preset, overrides = {}, profile = null) {
  const p = { ...DEFAULTS, ...(preset ? preset.params : {}), ...overrides };
  if (preset && preset.targetF0 && profile && profile.f0 > 0 && overrides.pitch === undefined) {
    const semis = 12 * Math.log2(preset.targetF0 / profile.f0);
    p.pitch = Math.max(-12, Math.min(12, Math.round(semis * 2) / 2));
    if (overrides.formant === undefined) {
      p.formant = Math.max(-8, Math.min(8, Math.round(p.pitch * (preset.formantFollow ?? 0.4) * 2) / 2));
    }
  }
  return p;
}

export function paramsToWorklet(p) {
  return {
    pitch: p.pitch,
    formant: Math.pow(2, p.formant / 12),
    mode: p.mode,
    robotHz: p.robotHz,
    tuneKey: p.tuneKey,
    tuneScale: p.tuneScale,
    whisper: p.whisper,
    crushBits: p.crushBits,
    crushDown: p.crushDown,
  };
}

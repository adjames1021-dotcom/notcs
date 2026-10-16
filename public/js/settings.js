// ---------------------------------------------------------------------------
// settings.js — player settings, saved in this browser (localStorage).
// ---------------------------------------------------------------------------

const KEY = 'notcs.settings.v1';

export const DEFAULT_SETTINGS = {
  name: '',
  // Mouse. CS2 formula: degrees turned = mouse counts x sensitivity x 0.022
  sensitivity: 1.25,
  zoomSensitivityRatio: 1.0,
  m_yaw: 0.022,
  m_pitch: 0.022,
  invertY: false,
  rawInput: true, // ask the browser for unaccelerated mouse input
  // Video
  renderScale: 1,
  shadows: true,
  maxFps: 0, // 0 = uncapped (vsync)
  viewmodelFov: 68,
  // Audio
  volume: 0.6,
  // Crosshair (CS2-style values)
  crosshair: {
    style: 'static', // 'static' or 'dynamic' (gap grows when you move/shoot)
    size: 2,
    thickness: 0.5,
    gap: -1,
    outline: true,
    outlineThickness: 1,
    dot: false,
    tStyle: false,
    color: '#50ff50',
    alpha: 255,
    followRecoil: false,
  },
  // Gameplay
  wheelJump: false, // bind mouse wheel down to jump instead of weapon switching
  showNetGraph: true,
  showFps: true,
  // Network testing (Practice mode only): add fake latency to test netcode
  fakeLagMs: 0,
  fakeJitterMs: 0,
  // Key bindings: action -> list of KeyboardEvent.code values
  binds: {
    forward: ['KeyW'],
    back: ['KeyS'],
    left: ['KeyA'],
    right: ['KeyD'],
    jump: ['Space'],
    duck: ['ControlLeft', 'KeyC'],
    walk: ['ShiftLeft'],
    use: ['KeyE'],
    reload: ['KeyR'],
    drop: ['KeyG'],
    lastWeapon: ['KeyQ'],
    inspect: ['KeyF'],
    slot1: ['Digit1'],
    slot2: ['Digit2'],
    slot3: ['Digit3'],
    slot4: ['Digit4'],
    slot5: ['Digit5'],
    buy: ['KeyB'],
    score: ['Tab'],
    debug: ['F3'],
    chat: ['KeyY'],
    teamChat: ['KeyU'],
    teamMenu: ['KeyM'],
  },
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return structuredClone(base);
  const out = Array.isArray(base) ? [] : {};
  for (const k of Object.keys(base)) {
    const b = base[k], o = over[k];
    if (b && typeof b === 'object' && !Array.isArray(b)) out[k] = deepMerge(b, o);
    else out[k] = o === undefined ? structuredClone(b) : o;
  }
  return out;
}

export function loadSettings() {
  let saved = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) saved = JSON.parse(raw);
  } catch { /* private mode or blocked storage: use defaults */ }
  return deepMerge(DEFAULT_SETTINGS, saved);
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

/** Degrees of rotation for a raw mouse delta (CS2's formula). */
export function mouseToDegrees(settings, dx, dy, zoomFovRatio = 1) {
  const sens = settings.sensitivity * (zoomFovRatio < 1 ? zoomFovRatio * settings.zoomSensitivityRatio : 1);
  return {
    yaw: -dx * sens * settings.m_yaw,
    pitch: dy * sens * settings.m_pitch * (settings.invertY ? -1 : 1),
  };
}

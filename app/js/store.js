// Хранилище данных: всё лежит локально на устройстве (localStorage).
// Записи не удаляются физически, а помечаются deleted — так слияние
// резервных копий с разных устройств корректно переносит удаления.

const KEY = 'metermate.v1';
const MAX_SAMPLES = 6; // сколько образцов каждой цифры хранить на счётчик

export const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);

const now = () => new Date().toISOString();

function defaults() {
  return {
    version: 1,
    settings: { currency: '', updatedAt: '' },
    // Постоянные id и пустой updatedAt: на всех устройствах это «одни и те же»
    // счётчики, и при импорте любое переименование побеждает умолчание.
    meters: [
      { id: 'm1', name: 'Счётчик 1', drums: 6, decimals: 1, updatedAt: '' },
      { id: 'm2', name: 'Счётчик 2', drums: 6, decimals: 1, updatedAt: '' },
    ],
    readings: [],
    tariffs: [],
    templates: {}, // meterId -> { '0': [base64, ...], ..., '9': [...] }
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults(), ...JSON.parse(raw) };
  } catch (e) {
    console.warn('Не удалось прочитать данные', e);
  }
  return defaults();
}

let state = load();
const listeners = new Set();

function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
  listeners.forEach((fn) => fn());
}

export const onChange = (fn) => listeners.add(fn);

const alive = (x) => !x.deleted;
const byDate = (a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt);

// --- Счётчики ---

export const meters = () => state.meters.filter(alive);
export const meter = (id) => state.meters.find((m) => m.id === id);

export function addMeter(name) {
  const m = { id: uid(), name, drums: 6, decimals: 1, updatedAt: now() };
  state.meters.push(m);
  save();
  return m;
}

export function updateMeter(id, patch) {
  Object.assign(meter(id), patch, { updatedAt: now() });
  save();
}

export const removeMeter = (id) => updateMeter(id, { deleted: true });

// --- Показания ---

export const readings = (meterId) =>
  state.readings.filter((r) => alive(r) && r.meterId === meterId).sort(byDate);

export const allReadings = () => state.readings.filter(alive).sort(byDate);

export function addReading({ meterId, date, value, source }) {
  const r = { id: uid(), meterId, date, value, source, createdAt: now(), updatedAt: now() };
  state.readings.push(r);
  save();
  return r;
}

export function removeReading(id) {
  Object.assign(state.readings.find((r) => r.id === id), { deleted: true, updatedAt: now() });
  save();
}

// --- Тарифы ---

export const tariffs = () => state.tariffs.filter(alive).sort((a, b) => a.from.localeCompare(b.from));

export function addTariff({ from, price, meterId }) {
  state.tariffs.push({ id: uid(), from, price, meterId: meterId || '', updatedAt: now() });
  save();
}

export function removeTariff(id) {
  Object.assign(state.tariffs.find((t) => t.id === id), { deleted: true, updatedAt: now() });
  save();
}

// --- Настройки ---

export const settings = () => state.settings;

export function setSetting(key, value) {
  state.settings = { ...state.settings, [key]: value, updatedAt: now() };
  save();
}

// --- Образцы цифр для распознавания ---

export const templates = (meterId) => state.templates[meterId] || {};

export const templateCount = (meterId) =>
  Object.values(templates(meterId)).reduce((n, list) => n + list.length, 0);

export function addTemplates(meterId, samples) {
  const own = (state.templates[meterId] ||= {});
  for (const [digit, list] of Object.entries(samples)) {
    own[digit] = [...(own[digit] || []), ...list].slice(-MAX_SAMPLES);
  }
  save();
}

export function resetTemplates(meterId) {
  delete state.templates[meterId];
  save();
}

// --- Резервная копия и слияние ---

export const snapshot = () => JSON.parse(JSON.stringify(state));

function mergeList(local, incoming = []) {
  const byId = new Map(local.map((x) => [x.id, x]));
  let changed = 0;
  for (const item of incoming) {
    const mine = byId.get(item.id);
    if (!mine || (item.updatedAt || '') > (mine.updatedAt || '')) {
      byId.set(item.id, item);
      changed++;
    }
  }
  return [[...byId.values()], changed];
}

export function merge(data) {
  if (!data || data.version !== 1) throw new Error('Это не файл резервной копии MeterMate');
  let total = 0;
  for (const key of ['meters', 'readings', 'tariffs']) {
    const [list, changed] = mergeList(state[key], data[key]);
    state[key] = list;
    total += changed;
  }
  for (const [meterId, digits] of Object.entries(data.templates || {})) {
    const own = (state.templates[meterId] ||= {});
    for (const [digit, list] of Object.entries(digits)) {
      own[digit] = [...new Set([...(own[digit] || []), ...list])].slice(-MAX_SAMPLES);
    }
  }
  if ((data.settings?.updatedAt || '') > (state.settings.updatedAt || '')) state.settings = data.settings;
  save();
  return total;
}

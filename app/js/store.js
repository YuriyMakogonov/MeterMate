// Хранилище данных: всё лежит локально на устройстве (localStorage).
// Записи не удаляются физически, а помечаются deleted — так слияние
// резервных копий и таблиц с разных устройств корректно переносит удаления.

const KEY = 'metermate.v1';
const MAX_SAMPLES = 6; // сколько образцов каждой цифры хранить на счётчик

// Коллекции записей, привязанных к счётчику (у тарифа meterId может быть пустым = все)
export const KINDS = ['readings', 'payments', 'adjustments', 'dues', 'tariffs'];

export const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);

const now = () => new Date().toISOString();

function defaults() {
  return {
    version: 1,
    settings: { currency: 'BYN', commission: 2, updatedAt: '' },
    // Постоянные id и пустой updatedAt: на всех устройствах это «одни и те же»
    // счётчики, и при импорте любое переименование побеждает умолчание.
    meters: [
      { id: 'm1', name: 'Счётчик 1', drums: 6, decimals: 1, updatedAt: '' },
      { id: 'm2', name: 'Счётчик 2', drums: 6, decimals: 1, updatedAt: '' },
    ],
    readings: [],
    payments: [],
    adjustments: [],
    dues: [],
    tariffs: [],
    templates: {}, // meterId -> { '0': [base64, ...], ..., '9': [...] }
    templatesVersion: 2, // формат образцов; при смене алгоритма старые сбрасываются
    sync: { at: '' }, // когда данные последний раз совпадали с таблицей
    google: { url: '', token: '', auto: true, hash: '', pending: false, error: '', at: '' },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const data = JSON.parse(raw);
      const base = defaults();
      if (data.templatesVersion !== base.templatesVersion) {
        data.templates = {};
        data.templatesVersion = base.templatesVersion;
      }
      return { ...base, ...data, settings: { ...base.settings, ...data.settings }, google: { ...base.google, ...data.google } };
    }
  } catch (e) {
    console.warn('Не удалось прочитать данные', e);
  }
  return defaults();
}

let state = load();
const listeners = new Set();

function save({ silent = false } = {}) {
  localStorage.setItem(KEY, JSON.stringify(state));
  if (!silent) listeners.forEach((fn) => fn());
}

/** Подписка на изменения данных (не вызывается для служебных полей синхронизации). */
export const onChange = (fn) => listeners.add(fn);

const alive = (x) => !x.deleted;
const dateOf = (x) => x.date || x.from || '';
export const byDate = (a, b) =>
  dateOf(a).localeCompare(dateOf(b)) || (a.createdAt || '').localeCompare(b.createdAt || '');

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

// --- Записи: показания, оплаты, сверки, взносы, тарифы ---

export const list = (kind, meterId) =>
  state[kind].filter((x) => alive(x) && (meterId == null || x.meterId === meterId)).sort(byDate);

export const get = (kind, id) => state[kind].find((x) => x.id === id);

export function add(kind, fields) {
  const rec = { id: uid(), ...fields, createdAt: now(), updatedAt: now() };
  state[kind].push(rec);
  save();
  return rec;
}

export function update(kind, id, patch) {
  Object.assign(get(kind, id), patch, { updatedAt: now() });
  save();
}

export const remove = (kind, id) => update(kind, id, { deleted: true });

// Совместимость с экранами показаний и тарифов
export const readings = (meterId) => list('readings', meterId);
export const allReadings = () => list('readings');
export const addReading = (fields) => add('readings', fields);
export const removeReading = (id) => remove('readings', id);
export const tariffs = () => list('tariffs');
export const addTariff = ({ from, price, meterId }) => add('tariffs', { from, price, meterId: meterId || '' });
export const removeTariff = (id) => remove('tariffs', id);

/**
 * Применить набор изменений из таблицы одной операцией.
 * ops: [{ kind, id, fields, op: 'add' | 'update' | 'remove' }]
 */
export function applyOps(ops) {
  const stamp = now();
  for (const { kind, id, fields, op } of ops) {
    const existing = get(kind, id);
    if (op === 'remove') {
      if (existing) Object.assign(existing, { deleted: true, updatedAt: stamp });
    } else if (existing) {
      Object.assign(existing, fields, { deleted: false, updatedAt: stamp });
    } else {
      state[kind].push({ id, ...fields, createdAt: fields.createdAt || stamp, updatedAt: stamp });
    }
  }
  save();
}

// --- Настройки и служебное ---

export const settings = () => state.settings;

export function setSetting(key, value) {
  state.settings = { ...state.settings, [key]: value, updatedAt: now() };
  save();
}

export const syncInfo = () => state.sync;

export function markSynced(at = now()) {
  state.sync = { at };
  save({ silent: true });
}

export const google = () => state.google;

export function setGoogle(patch) {
  state.google = { ...state.google, ...patch };
  save({ silent: true });
}

// --- Образцы цифр для распознавания ---

export const templates = (meterId) => state.templates[meterId] || {};

export const templateCount = (meterId) =>
  Object.values(templates(meterId)).reduce((n, items) => n + items.length, 0);

export function addTemplates(meterId, samples) {
  const own = (state.templates[meterId] ||= {});
  for (const [digit, items] of Object.entries(samples)) {
    own[digit] = [...(own[digit] || []), ...items].slice(-MAX_SAMPLES);
  }
  save({ silent: true });
}

export function resetTemplates(meterId) {
  delete state.templates[meterId];
  save({ silent: true });
}

// --- Резервная копия и слияние ---

export function snapshot() {
  const { google: _, ...rest } = state; // адрес и ключ Google в копию не попадают
  return JSON.parse(JSON.stringify(rest));
}

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
  for (const key of ['meters', ...KINDS]) {
    const [merged, changed] = mergeList(state[key], data[key]);
    state[key] = merged;
    total += changed;
  }
  const templates = data.templatesVersion === state.templatesVersion ? data.templates : {};
  for (const [meterId, digits] of Object.entries(templates || {})) {
    const own = (state.templates[meterId] ||= {});
    for (const [digit, items] of Object.entries(digits)) {
      own[digit] = [...new Set([...(own[digit] || []), ...items])].slice(-MAX_SAMPLES);
    }
  }
  if ((data.settings?.updatedAt || '') > (state.settings.updatedAt || '')) {
    state.settings = { ...state.settings, ...data.settings };
  }
  save();
  return total;
}

// Таблица из двух вкладок:
//   «Гаражи» — раскладка пользователя для людей (блоки по гаражам, формулы);
//   «Данные» — плоский список записей, который читает загрузка.
// Здесь же сравнение загруженных данных с приложением (предпросмотр) и
// проверка, не правили ли «Гаражи» руками.

import * as store from './store.js';
import { ledger } from './ledger.js';
import { dayNum, fromDayNum } from './stats.js';

export const MAIN = 'Гаражи';
export const DATA = 'Данные';
// Скрытый снимок «Гаражей» в момент выгрузки: с ним сравнивается «Гаражи»
// при загрузке, чтобы найти правки, сделанные в main руками
export const SNAPSHOT = '_Гаражи_снимок';

// --- Даты ---

export const toSerial = (iso) => dayNum(iso) + 25569; // 25569 — 01.01.1970 в днях Excel
export const fromSerial = (n) => fromDayNum(Math.round(n) - 25569);

/** Дата из ячейки: число Excel, «2025-04-10», «10.04.2025», «16,04,24». */
export function parseDate(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) return fromSerial(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[.,/](\d{1,2})[.,/](\d{2}|\d{4})$/);
  if (!m) return null;
  const [d, mo] = [+m[1], +m[2]];
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Число из ячейки: 12.5, «12,5», «20р». */
export function parseNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const m = v.replace(/\s/g, '').replace(',', '.').match(/^-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

const round = (v, d = 6) => Math.round(v * 10 ** d) / 10 ** d;

// --- Типы записей ---

export const TYPE_NAMES = {
  payments: 'оплата', adjustments: 'сверка', dues: 'взнос', readings: 'показание', tariffs: 'тариф',
};
const KIND_BY_TYPE = Object.fromEntries(Object.entries(TYPE_NAMES).map(([k, v]) => [v, k]));

// Поля, которые сравниваются при загрузке
export const FIELDS = {
  payments: ['meterId', 'date', 'amount', 'commission', 'tariff', 'comment'],
  adjustments: ['meterId', 'date', 'paidTo', 'comment'],
  dues: ['meterId', 'date', 'amount', 'comment'],
  readings: ['meterId', 'date', 'value', 'comment'],
  tariffs: ['meterId', 'from', 'price'],
};

export const FIELD_NAMES = {
  meterId: 'гараж', date: 'дата', from: 'дата', amount: 'сумма', commission: 'комиссия',
  tariff: 'тариф', price: 'тариф', paidTo: 'оплачено по', value: 'показание', comment: 'комментарий',
};

// --- Модель для построения таблицы ---

/** Текущие данные приложения в виде простых массивов. */
export function currentModel() {
  return {
    meters: store.meters(),
    ...Object.fromEntries(store.KINDS.map((k) => [k, store.list(k)])),
  };
}

// --- Вкладка «Гаражи» ---

const HEAD = ['', 'Дата', 'Платёж', 'Комиссия %', 'Денег дошло', 'Тариф', 'Киловат', 'Счётчик до оплаты',
  'Счётчик оплачен ПО', 'кВт за год', 'Денег за год', '', 'Дата', 'Взнос', 'Примечание', 'Комментарий'];
const COLS = HEAD.length;

export function buildMain(model) {
  const rows = [];
  for (const m of model.meters) {
    const own = (kind) => model[kind].filter((x) => x.meterId === m.id).sort(store.byDate);
    const pays = own('payments'), adjs = own('adjustments'), dues = own('dues');
    if (!pays.length && !adjs.length && !dues.length) continue;

    rows.push([null, { v: m.name, style: 'bold' }]);
    rows.push(HEAD.map((t) => (t ? { v: t, style: 'bold' } : null)));
    const events = ledger(pays, adjs).rows;
    const first = rows.length + 1; // номер первой строки данных (с 1, как в Excel)
    const n = Math.max(events.length, dues.length, 1);
    const sum = { amount: 0, net: 0, kwh: 0, dues: 0 };
    let yearStart = first, yearKwh = 0, yearMoney = 0;

    for (let i = 0; i < n; i++) {
      const r = first + i;
      const row = new Array(COLS).fill(null);
      const e = events[i];
      if (e) {
        const year = e.rec.date.slice(0, 4);
        if (i === 0 || events[i - 1].rec.date.slice(0, 4) !== year) {
          row[0] = { v: +year, style: 'bold' };
          yearStart = r;
          yearKwh = 0;
          yearMoney = 0;
        }
        row[1] = { v: toSerial(e.rec.date), style: 'date' };
        if (e.kind === 'payment') {
          const p = e.rec;
          row[2] = { v: p.amount, style: 'money' };
          row[3] = { v: p.commission };
          row[4] = { f: `C${r}-(C${r}*(D${r}/100))`, v: round(e.net), style: 'money' };
          row[5] = { v: p.tariff, style: 'tariff' };
          row[6] = { f: `E${r}/F${r}`, v: round(e.kwh), style: 'num' };
          row[7] = i === 0 ? { v: round(e.from), style: 'num' } : { f: `I${r - 1}`, v: round(e.from), style: 'num' };
          row[8] = { f: `H${r}+G${r}`, v: round(e.to), style: 'num' };
          yearKwh += e.kwh;
          yearMoney += p.amount;
          sum.amount += p.amount;
          sum.net += e.net;
          sum.kwh += e.kwh;
        } else {
          row[2] = { v: 'Сверка' };
          row[7] = { v: round(e.to), style: 'num' };
          row[8] = { f: `H${r}`, v: round(e.to), style: 'num' };
        }
        if (e.rec.comment) row[15] = { v: e.rec.comment };
        const next = events[i + 1];
        if (!next || next.rec.date.slice(0, 4) !== year) {
          row[9] = { f: `SUM(G${yearStart}:G${r})`, v: round(yearKwh), style: 'num' };
          row[10] = { f: `SUM(C${yearStart}:C${r})`, v: round(yearMoney), style: 'money' };
        }
      }
      const d = dues[i];
      if (d) {
        row[12] = { v: toSerial(d.date), style: 'date' };
        row[13] = { v: d.amount, style: 'money' };
        if (d.comment) row[14] = { v: d.comment };
        sum.dues += d.amount;
      }
      rows.push(row);
    }

    const last = first + n - 1, t = first + n;
    const total = new Array(COLS).fill(null);
    total[1] = { v: 'Итого', style: 'bold' };
    total[2] = { f: `SUM(C${first}:C${last})`, v: round(sum.amount), style: 'money' };
    total[3] = { f: `C${t}-E${t}`, v: round(sum.amount - sum.net), style: 'money' };
    total[4] = { f: `SUM(E${first}:E${last})`, v: round(sum.net), style: 'money' };
    total[6] = { f: `SUM(G${first}:G${last})`, v: round(sum.kwh), style: 'num' };
    total[13] = { f: `SUM(N${first}:N${last})`, v: round(sum.dues), style: 'money' };
    rows.push(total);
    rows.push([]);
  }
  return { name: MAIN, rows, widths: [7, 11, 10, 11, 12, 9, 10, 14, 14, 11, 11, 3, 11, 9, 28, 30], freeze: false };
}

// --- Вкладка «Данные» ---

export const DATA_HEAD = ['id', 'Гараж', 'Тип', 'Дата', 'Сумма', 'Комиссия %', 'Тариф', 'Значение', 'Комментарий'];

export function buildData(model) {
  const nameOf = (id) => model.meters.find((m) => m.id === id)?.name || '';
  const rows = [DATA_HEAD.map((t) => ({ v: t, style: 'bold' }))];
  const date = (iso) => ({ v: toSerial(iso), style: 'date' });
  for (const t of model.tariffs) {
    rows.push([t.id, nameOf(t.meterId), 'тариф', date(t.from), null, null, { v: t.price, style: 'tariff' }, null, null]);
  }
  for (const m of model.meters) {
    const recs = ['payments', 'adjustments', 'dues', 'readings']
      .flatMap((kind) => model[kind].filter((x) => x.meterId === m.id).map((rec) => ({ kind, rec })))
      .sort((a, b) => store.byDate(a.rec, b.rec));
    for (const { kind, rec } of recs) {
      const row = [rec.id, m.name, TYPE_NAMES[kind], date(rec.date), null, null, null, null, rec.comment || null];
      if (kind === 'payments') {
        row[4] = { v: rec.amount, style: 'money' };
        row[5] = rec.commission;
        row[6] = { v: rec.tariff, style: 'tariff' };
      } else if (kind === 'dues') row[4] = { v: rec.amount, style: 'money' };
      else if (kind === 'adjustments') row[7] = { v: rec.paidTo, style: 'num' };
      else row[7] = { v: rec.value, style: 'num' };
      rows.push(row);
    }
  }
  return { name: DATA, rows, widths: [38, 16, 12, 11, 10, 11, 9, 11, 36] };
}

export function buildSnapshot(main) {
  const rows = main.rows.map((row) => (row || []).map((c) => {
    if (c == null || typeof c !== 'object') return c ?? null;
    return c.style === 'date' ? { v: c.v, style: 'date' } : c.v ?? null;
  }));
  return { name: SNAPSHOT, rows, hidden: true, freeze: false };
}

export function buildWorkbookSheets(model = currentModel()) {
  const main = buildMain(model);
  return [main, buildData(model), buildSnapshot(main)];
}

// --- Чтение вкладки «Данные» ---

const plain = (cell) => (cell && typeof cell === 'object' ? cell.v : cell) ?? null;

/** grid — двумерный массив значений или ячеек { v }. */
export function parseData(grid) {
  const head = (grid[0] || []).map((c) => String(plain(c) ?? '').trim().toLowerCase());
  const col = (name) => head.indexOf(name.toLowerCase());
  const idx = Object.fromEntries(DATA_HEAD.map((h) => [h, col(h)]));
  if (idx['Тип'] < 0 || idx['Дата'] < 0) throw new Error('Во вкладке «Данные» нет колонок «Тип» и «Дата»');

  const records = [], errors = [];
  const defaultCommission = store.settings().commission;
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const get = (h) => (idx[h] >= 0 ? plain(row[idx[h]]) : null);
    if (row.every((c) => plain(c) == null || plain(c) === '')) continue;
    const where = `«Данные», строка ${r + 1}`;
    const kind = KIND_BY_TYPE[String(get('Тип') || '').trim().toLowerCase()];
    if (!kind) { errors.push(`${where}: неизвестный тип «${get('Тип') ?? ''}»`); continue; }
    const date = parseDate(get('Дата'));
    if (!date) { errors.push(`${where}: не понял дату «${get('Дата') ?? ''}»`); continue; }
    const meterName = String(get('Гараж') ?? '').trim();
    if (!meterName && kind !== 'tariffs') { errors.push(`${where}: не указан гараж`); continue; }
    const comment = String(get('Комментарий') ?? '').trim();
    const num = (h) => parseNum(get(h));

    let fields;
    if (kind === 'payments') {
      fields = { date, amount: num('Сумма'), commission: num('Комиссия %') ?? defaultCommission, tariff: num('Тариф'), comment };
      if (!(fields.amount > 0) || !(fields.tariff > 0)) { errors.push(`${where}: у оплаты нужны сумма и тариф`); continue; }
    } else if (kind === 'dues') {
      fields = { date, amount: num('Сумма'), comment };
      if (!(fields.amount > 0)) { errors.push(`${where}: у взноса нужна сумма`); continue; }
    } else if (kind === 'adjustments') {
      fields = { date, paidTo: num('Значение'), comment };
      if (fields.paidTo == null) { errors.push(`${where}: у сверки нужно значение «оплачено по»`); continue; }
    } else if (kind === 'readings') {
      fields = { date, value: num('Значение'), comment, source: 'table' };
      if (fields.value == null) { errors.push(`${where}: у показания нужно значение`); continue; }
    } else {
      fields = { from: date, price: num('Тариф') };
      if (!(fields.price > 0)) { errors.push(`${where}: у тарифа нужна цена`); continue; }
    }
    const id = String(get('id') ?? '').trim() || null;
    records.push({ kind, id, meterName, fields, order: r });
  }
  return { records, errors };
}

// --- Сравнение с приложением ---

const norm = (v) => (v == null ? '' : typeof v === 'string' ? v.trim() : v);
function same(a, b) {
  a = norm(a);
  b = norm(b);
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  return a === b;
}

/**
 * План сопоставления гаражей: имя → существующий счётчик или новый.
 * renameDefaults: занять счётчики с именем по умолчанию («Счётчик N») по порядку.
 */
function meterPlan(names, renameDefaults) {
  const meters = store.meters();
  const free = renameDefaults ? meters.filter((m) => /^Счётчик \d+$/.test(m.name)) : [];
  const plan = [];
  for (const name of names) {
    if (!name) continue;
    const found = meters.find((m) => m.name.trim().toLowerCase() === name.toLowerCase());
    if (found) plan.push({ name, id: found.id });
    else if (free.length) plan.push({ name, id: free.shift().id, rename: true });
    else plan.push({ name, id: null });
  }
  return plan;
}

/**
 * Сравнить записи из таблицы с приложением.
 * detectRemoved: считать удалёнными записи, которых нет в таблице, но которые
 * были в приложении на момент последней синхронизации.
 */
export function diff(records, { detectRemoved = true, renameDefaults = false } = {}) {
  const names = [...new Set(records.map((r) => r.meterName).filter(Boolean))];
  const plan = meterPlan(names, renameDefaults);
  const meterIdOf = (name) => (name ? plan.find((p) => p.name === name)?.id || `new:${name}` : '');

  const added = [], changed = [], seen = new Set();
  let stamp = Date.now();
  for (const r of records) {
    const fields = { ...r.fields, meterId: meterIdOf(r.meterName) };
    const existing = r.id && store.get(r.kind, r.id);
    if (r.id) seen.add(`${r.kind}:${r.id}`);
    if (!existing || existing.deleted) {
      // Порядок строк задаёт порядок записей с одной датой
      added.push({ kind: r.kind, id: r.id || store.uid(), fields: { ...fields, createdAt: new Date(stamp++).toISOString() }, meterName: r.meterName });
      continue;
    }
    const changes = FIELDS[r.kind]
      .filter((f) => !same(existing[f], fields[f]))
      .map((f) => ({ field: f, from: existing[f], to: fields[f] }));
    if (changes.length) changed.push({ kind: r.kind, id: r.id, fields, before: existing, changes, meterName: r.meterName });
  }

  const removed = [], onlyApp = [];
  if (detectRemoved) {
    const syncedAt = store.syncInfo().at;
    for (const kind of store.KINDS) {
      for (const rec of store.list(kind)) {
        if (seen.has(`${kind}:${rec.id}`)) continue;
        const wasSynced = syncedAt && rec.createdAt <= syncedAt && rec.updatedAt <= syncedAt;
        (wasSynced ? removed : onlyApp).push({ kind, id: rec.id, rec });
      }
    }
  }
  return { added, changed, removed, onlyApp, meters: plan };
}

export function applyDiff(d, { applyRemoved = true } = {}) {
  const ids = {};
  for (const p of d.meters) {
    if (!p.id) ids[`new:${p.name}`] = store.addMeter(p.name).id;
    else if (p.rename) store.updateMeter(p.id, { name: p.name });
  }
  const meterId = (id) => ids[id] || id;
  const ops = [
    ...d.added.map((a) => ({ kind: a.kind, id: a.id, op: 'add', fields: { ...a.fields, meterId: meterId(a.fields.meterId) } })),
    ...d.changed.map((c) => ({ kind: c.kind, id: c.id, op: 'update', fields: { ...c.fields, meterId: meterId(c.fields.meterId) } })),
    ...(applyRemoved ? d.removed.map((x) => ({ kind: x.kind, id: x.id, op: 'remove' })) : []),
  ];
  store.applyOps(ops);
}

// --- Проверка вкладки «Гаражи» ---

function colName(i) {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

const isoToRu = (iso) => iso.split('-').reverse().join('.');
const DATE_COLS = new Set([1, 12]); // B и M — даты

function shown(v, c) {
  if (v == null || v === '') return 'пусто';
  if (DATE_COLS.has(c) && typeof v === 'number' && v > 20000) return isoToRu(fromSerial(v));
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return isoToRu(v);
  return typeof v === 'number' ? String(round(v, 4)).replace('.', ',') : `«${v}»`;
}

/**
 * Найти правки, сделанные во вкладке «Гаражи» руками: сравнить её со
 * снимком, который приложение положило рядом при выгрузке.
 * actual, snapshot — двумерные массивы значений (или ячеек { v }).
 */
export function checkMain(actual, snapshot, limit = 30) {
  const out = [];
  const rows = Math.max(actual.length, snapshot.length);
  for (let r = 0; r < rows && out.length < limit; r++) {
    const width = Math.max(actual[r]?.length || 0, snapshot[r]?.length || 0);
    for (let c = 0; c < width && out.length < limit; c++) {
      let a = plain(actual[r]?.[c]), e = plain(snapshot[r]?.[c]);
      if (typeof e === 'number' && typeof a === 'string') a = parseNum(a) ?? a;
      if (typeof a === 'number' && typeof e === 'string') e = parseNum(e) ?? e;
      if (!same(e ?? null, a ?? null)) {
        out.push({ ref: `${colName(c)}${r + 1}`, expected: shown(e, c), actual: shown(a, c) });
      }
    }
  }
  return out;
}

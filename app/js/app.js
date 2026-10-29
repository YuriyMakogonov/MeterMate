import * as store from './store.js';
import { h } from './dom.js';
import { openCamera } from './camera.js';
import { Cropper } from './cropper.js';
import { recognize, samplesFrom } from './recognizer.js';
import { intervals, aggregate, byMonth, byYear, priceOn } from './stats.js';
import { workbook, backup } from './export.js';
import { ledger, balance, paymentYears } from './ledger.js';
import { readXlsx } from './xlsx.js';
import {
  MAIN, DATA, SNAPSHOT, parseData, parseNum, diff, applyDiff, checkMain, FIELD_NAMES,
} from './sheets.js';
import { parseLegacy } from './legacy.js';
import * as google from './google.js';

const VERSION = '0.2.0';

const $view = document.getElementById('view');
const $overlay = document.getElementById('overlay');
const $toast = document.getElementById('toast');

let tab = 'home';
let meterId = store.meters()[0]?.id;
let historyFilter = 'all';
let statsYear = null;
let statsMeter = 'all';
let payMeter = null;

// --- Форматирование ---

const pad = (n) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const fmt = (n, d) => n.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (n) => fmt(n, Number.isInteger(n) ? 0 : 1);
const kwh = (n) => `${num(n)} кВт·ч`;
const money = (n) => {
  if (n == null) return '—';
  const cur = store.settings().currency;
  return fmt(n, 2) + (cur ? ` ${cur}` : '');
};
const price = (n) => (n == null ? '—' : n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
const date = (s) => s.split('-').reverse().join('.');
const valueOf = (m, v) => fmt(v, m.decimals);
const aspectOf = (m) => m.drums * 0.8; // ширина/высота окошка барабанов
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август',
  'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.hidden = true), 3500);
}

function showOverlay(node) {
  $overlay.replaceChildren(node);
  $overlay.hidden = false;
  document.body.classList.add('locked');
}

function closeOverlay() {
  $overlay.hidden = true;
  $overlay.replaceChildren();
  document.body.classList.remove('locked');
}

async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function chips(items, current, onPick) {
  return h('div', { class: 'chips' }, items.map(([id, label]) =>
    h('button', { class: id === current ? 'chip on' : 'chip', onclick: () => onPick(id) }, label)));
}

const meterChips = (current, onPick, withAll = false) =>
  chips([...(withAll ? [['all', 'Все']] : []), ...store.meters().map((m) => [m.id, m.name])], current, onPick);

// --- Главная: снять показание ---

function viewHome() {
  const meters = store.meters();
  if (!meters.some((m) => m.id === meterId)) meterId = meters[0]?.id;
  const fileInput = h('input', {
    type: 'file', accept: 'image/*', hidden: true,
    onchange: (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) fromFile(f);
    },
  });
  return [
    h('h1', {}, 'MeterMate'),
    meterChips(meterId, (id) => { meterId = id; render(); }),
    h('div', { class: 'actions' },
      h('button', { class: 'big primary', onclick: startCamera }, '📷 Снять камерой'),
      h('button', { class: 'big', onclick: () => fileInput.click() }, '🖼 Выбрать фото'),
      h('button', { class: 'big ghost', onclick: () => openConfirm({}) }, '⌨️ Ввести вручную'),
      fileInput),
    h('h2', {}, 'Сейчас'),
    meters.map(summaryCard),
  ];
}

function summaryCard(m) {
  const rs = store.readings(m.id);
  const last = rs.at(-1);
  const iv = intervals(rs, store.tariffs(), m).at(-1);
  const b = balanceOf(m.id);
  return h('section', { class: 'card' },
    h('div', { class: 'card-title' }, m.name),
    last
      ? h('div', { class: 'reading' }, valueOf(m, last.value), h('small', {}, ` кВт·ч · ${date(last.date)}`))
      : h('div', { class: 'muted' }, 'Показаний пока нет'),
    iv && h('div', {}, `За ${iv.days} дн.: ${kwh(iv.kwh)} · ${money(iv.cost)}`),
    balanceBlock(m, b),
    h('div', { class: 'muted small' },
      b.tariff == null ? 'Тариф не задан — добавьте в настройках' : `Тариф: ${price(b.tariff)} за кВт·ч`,
      ` · образцов цифр: ${store.templateCount(m.id)}`));
}

// --- Баланс: оплачено по / долг / запас ---

const balanceOf = (id) => balance({
  payments: store.list('payments', id),
  adjustments: store.list('adjustments', id),
  readings: store.readings(id),
  tariffs: store.tariffs(),
  meterId: id,
  commission: store.settings().commission,
  today: today(),
});

function balanceBlock(m, b, { actions = true } = {}) {
  const pay = (amount) => h('button', {
    class: amount ? 'primary' : 'ghost',
    onclick: () => openPaymentForm({ meterId: m.id, amount }),
  }, amount ? `💳 Оплатить ${money(amount)}` : '💳 Внести оплату');
  if (b.paidTo == null) {
    return h('div', { class: 'balance' },
      h('div', { class: 'muted small' }, 'Оплат пока нет'),
      actions && pay());
  }
  const owes = b.debt != null && b.debt > 0.05;
  return h('div', { class: 'balance' },
    h('div', {}, 'Оплачено по счётчику: ', h('b', {}, num(b.paidTo))),
    b.debt == null
      ? h('div', { class: 'muted small' }, 'Снимите показание, чтобы увидеть долг или запас')
      : owes
        ? h('div', { class: 'debt' }, `Долг: ${kwh(b.debt)}`, b.exact ? ` ≈ ${money(b.exact)} с комиссией` : '')
        : h('div', { class: 'ok' }, `Запас: ${kwh(-b.debt)}`, b.tariff ? ` ≈ ${money(-b.debt * b.tariff)}` : ''),
    actions && pay(owes ? b.suggested : undefined));
}

// --- Формы оплаты, сверки и взноса ---

const field = (label, input, hint) => h('label', { class: 'field' }, label, input, hint && h('span', { class: 'small' }, hint));
const decimalInput = (value, attrs = {}) =>
  h('input', { type: 'text', inputmode: 'decimal', value: value ?? '', autocomplete: 'off', ...attrs });

function formScreen(title, body, { onSave, onDelete }) {
  showOverlay(h('div', { class: 'screen confirm' },
    h('header', { class: 'bar' },
      h('button', { class: 'link', onclick: closeOverlay }, 'Отмена'),
      h('b', {}, title),
      onDelete ? h('button', { class: 'link bad', onclick: onDelete }, 'Удалить') : h('span', {})),
    h('div', { class: 'confirm-body' }, body),
    h('footer', { class: 'bar' }, h('button', { class: 'primary wide', onclick: onSave }, 'Сохранить'))));
}

function removeWithConfirm(kind, id, what) {
  if (!confirm(`Удалить ${what}?`)) return;
  store.remove(kind, id);
  closeOverlay();
  toast('Удалено');
  render();
}

// Выбор гаража в форме новой записи
function garagePicker(current, onPick) {
  let value = current;
  const box = h('div', {});
  const draw = () => box.replaceChildren(meterChips(value, (id) => { value = id; draw(); onPick(id); }));
  draw();
  return box;
}

function openPaymentForm({ meterId: mid = meterId, id, amount } = {}) {
  const existing = id ? store.get('payments', id) : null;
  let currentMeter = existing?.meterId || mid;
  const defaults = store.settings();
  const tariffNow = (d) => priceOn(store.tariffs(), currentMeter, d);
  let tariffTouched = !!existing;

  const dateInput = h('input', {
    type: 'date', value: existing?.date || today(),
    onchange: () => {
      if (!tariffTouched) tariffInput.value = tariffNow(dateInput.value || today()) ?? '';
      update();
    },
  });
  const amountInput = decimalInput(existing?.amount ?? amount, { class: 'manual', placeholder: '0', oninput: () => update() });
  const commissionInput = decimalInput(existing?.commission ?? defaults.commission, { oninput: () => update() });
  const tariffInput = decimalInput(existing?.tariff ?? tariffNow(today()), {
    oninput: () => { tariffTouched = true; update(); },
  });
  const commentInput = h('input', { type: 'text', value: existing?.comment || '', placeholder: 'необязательно' });
  const preview = h('div', { class: 'summary' });

  const read = () => ({
    date: dateInput.value || today(),
    amount: parseNum(amountInput.value),
    commission: parseNum(commissionInput.value) ?? 0,
    tariff: parseNum(tariffInput.value),
    comment: commentInput.value.trim(),
  });

  function update() {
    const p = read();
    if (!(p.amount > 0) || !(p.tariff > 0)) {
      preview.replaceChildren(h('p', { class: 'muted' }, 'Введите сумму и тариф'));
      return;
    }
    const pays = store.list('payments', currentMeter).filter((x) => x.id !== id);
    pays.push({ ...p, id: 'draft', createdAt: existing?.createdAt || '9999' });
    pays.sort(store.byDate);
    const l = ledger(pays, store.list('adjustments', currentMeter));
    const row = l.rows.find((r) => r.rec.id === 'draft');
    const last = store.readings(currentMeter).at(-1);
    const after = last ? last.value - l.paidTo : null;
    preview.replaceChildren(
      h('p', {}, 'Дойдёт: ', h('b', {}, money(row.net)), h('span', { class: 'muted' }, ` (комиссия ${money(p.amount - row.net)})`)),
      h('p', {}, 'Оплатится: ', h('b', {}, kwh(row.kwh))),
      h('p', {}, 'Счётчик: ', h('b', {}, `${num(row.from)} → ${num(row.to)}`)),
      after == null ? null : after > 0.05
        ? h('p', { class: 'warn' }, `После оплаты останется долг ${kwh(after)} (по показанию ${num(last.value)} от ${date(last.date)})`)
        : h('p', { class: 'ok' }, `После оплаты запас ${kwh(-after)} (по показанию ${num(last.value)} от ${date(last.date)})`));
  }

  formScreen(existing ? 'Оплата' : 'Новая оплата', [
    !existing && garagePicker(currentMeter, (id2) => {
      currentMeter = id2;
      if (!tariffTouched) tariffInput.value = tariffNow(dateInput.value || today()) ?? '';
      update();
    }),
    field(`Сумма платежа, ${store.settings().currency || 'деньги'}`, amountInput),
    h('div', { class: 'row' },
      field('Дата', dateInput),
      field('Комиссия, %', commissionInput)),
    field('Тариф за кВт·ч', tariffInput, 'Сохраняется в этой оплате: смена тарифа потом её не изменит'),
    field('Комментарий', commentInput),
    preview,
  ], {
    onSave: () => {
      const p = read();
      if (!(p.amount > 0)) return toast('Укажите сумму');
      if (!(p.tariff > 0)) return toast('Укажите тариф');
      if (existing) store.update('payments', id, p);
      else store.add('payments', { ...p, meterId: currentMeter });
      closeOverlay();
      toast(`Оплата ${money(p.amount)} сохранена`);
      render();
    },
    onDelete: existing && (() => removeWithConfirm('payments', id, `оплату ${money(existing.amount)} от ${date(existing.date)}`)),
  });
  update();
  if (!existing && !amountInput.value) amountInput.focus();
}

function openAdjustmentForm({ meterId: mid = meterId, id } = {}) {
  const existing = id ? store.get('adjustments', id) : null;
  let currentMeter = existing?.meterId || mid;
  const dateInput = h('input', { type: 'date', value: existing?.date || today() });
  const valueInput = decimalInput(existing?.paidTo ?? balanceOf(currentMeter).paidTo?.toFixed(1), { class: 'manual' });
  const commentInput = h('input', { type: 'text', value: existing?.comment || '', placeholder: 'например: сверено с бухгалтером' });
  formScreen(existing ? 'Сверка' : 'Новая сверка', [
    !existing && garagePicker(currentMeter, (id2) => { currentMeter = id2; }),
    h('p', { class: 'muted small' }, 'Сверка выставляет «оплачено по счётчику» на указанное значение, например после сверки с бухгалтером. Следующие оплаты считаются от него.'),
    field('Оплачено по счётчику', valueInput),
    field('Дата', dateInput),
    field('Комментарий', commentInput),
  ], {
    onSave: () => {
      const paidTo = parseNum(valueInput.value);
      if (paidTo == null) return toast('Укажите значение');
      const fields = { date: dateInput.value || today(), paidTo, comment: commentInput.value.trim() };
      if (existing) store.update('adjustments', id, fields);
      else store.add('adjustments', { ...fields, meterId: currentMeter });
      closeOverlay();
      toast('Сверка сохранена');
      render();
    },
    onDelete: existing && (() => removeWithConfirm('adjustments', id, `сверку от ${date(existing.date)}`)),
  });
}

function openDueForm({ meterId: mid = meterId, id } = {}) {
  const existing = id ? store.get('dues', id) : null;
  let currentMeter = existing?.meterId || mid;
  const dateInput = h('input', { type: 'date', value: existing?.date || today() });
  const amountInput = decimalInput(existing?.amount, { class: 'manual', placeholder: '0' });
  const commentInput = h('input', { type: 'text', value: existing?.comment || '', placeholder: 'например: скидка 50%' });
  formScreen(existing ? 'Взнос' : 'Новый взнос', [
    !existing && garagePicker(currentMeter, (id2) => { currentMeter = id2; }),
    field(`Сумма взноса, ${store.settings().currency || 'деньги'}`, amountInput),
    field('Дата', dateInput),
    field('Примечание', commentInput),
  ], {
    onSave: () => {
      const amount2 = parseNum(amountInput.value);
      if (!(amount2 > 0)) return toast('Укажите сумму');
      const fields = { date: dateInput.value || today(), amount: amount2, comment: commentInput.value.trim() };
      if (existing) store.update('dues', id, fields);
      else store.add('dues', { ...fields, meterId: currentMeter });
      closeOverlay();
      toast('Взнос сохранён');
      render();
    },
    onDelete: existing && (() => removeWithConfirm('dues', id, `взнос ${money(existing.amount)} от ${date(existing.date)}`)),
  });
}

// --- Оплаты: журнал по гаражу ---

function viewPayments() {
  const meters = store.meters();
  if (!meters.some((m) => m.id === payMeter)) payMeter = meterId || meters[0]?.id;
  const m = store.meter(payMeter);
  const { rows } = ledger(store.list('payments', m.id), store.list('adjustments', m.id));
  const items = [
    ...rows.map((r) => ({ rec: r.rec, node: r.kind === 'payment' ? paymentItem(r) : adjustmentItem(r) })),
    ...store.list('dues', m.id).map((d) => ({ rec: d, node: dueItem(d) })),
  ].sort((a, b) => store.byDate(b.rec, a.rec));

  const list = [];
  let year = null;
  for (const it of items) {
    const y = it.rec.date.slice(0, 4);
    if (y !== year) list.push(h('li', { class: 'year' }, (year = y)));
    list.push(it.node);
  }

  return [
    h('h1', {}, 'Оплаты'),
    meterChips(payMeter, (id) => { payMeter = id; render(); }),
    h('section', { class: 'card' }, balanceBlock(m, balanceOf(m.id), { actions: false })),
    h('div', { class: 'buttons' },
      h('button', { class: 'primary', onclick: () => openPaymentForm({ meterId: m.id }) }, '+ Оплата'),
      h('button', { onclick: () => openAdjustmentForm({ meterId: m.id }) }, '+ Сверка'),
      h('button', { onclick: () => openDueForm({ meterId: m.id }) }, '+ Взнос')),
    items.length
      ? h('ul', { class: 'list' }, list)
      : h('p', { class: 'empty' }, 'Оплат пока нет. Историю можно загрузить из таблицы в настройках.'),
  ];
}

function paymentItem(r) {
  const p = r.rec;
  return h('li', { class: 'item tap', onclick: () => openPaymentForm({ id: p.id }) },
    h('div', { class: 'item-main' },
      h('div', {}, '💳 ', h('b', {}, money(p.amount)), h('span', { class: 'muted' }, ` · ${date(p.date)}`)),
      h('div', { class: 'muted small' }, `дошло ${money(r.net)} · тариф ${price(p.tariff)} · ${kwh(r.kwh)}`),
      p.comment && h('div', { class: 'muted small' }, p.comment)),
    h('div', { class: 'item-side small' }, `${num(r.from)} →`, h('br', {}), h('b', {}, num(r.to))));
}

function adjustmentItem(r) {
  const a = r.rec;
  return h('li', { class: 'item tap adj', onclick: () => openAdjustmentForm({ id: a.id }) },
    h('div', { class: 'item-main' },
      h('div', {}, '⚖️ ', h('b', {}, 'Сверка'), h('span', { class: 'muted' }, ` · ${date(a.date)}`)),
      a.comment && h('div', { class: 'muted small' }, a.comment)),
    h('div', { class: 'item-side small' }, 'оплачено по', h('br', {}), h('b', {}, num(a.paidTo))));
}

function dueItem(d) {
  return h('li', { class: 'item tap', onclick: () => openDueForm({ id: d.id }) },
    h('div', { class: 'item-main' },
      h('div', {}, '🧾 ', h('b', {}, `Взнос ${money(d.amount)}`), h('span', { class: 'muted' }, ` · ${date(d.date)}`)),
      d.comment && h('div', { class: 'muted small' }, d.comment)));
}

async function startCamera() {
  const m = store.meter(meterId);
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('Камера недоступна в этом браузере — выберите фото');
    return;
  }
  showOverlay(h('div', { class: 'screen camera' }, h('div', { class: 'cam-hint' }, 'Запуск камеры…')));
  try {
    const shot = await openCamera($overlay, {
      drums: m.drums, decimals: m.decimals, aspect: aspectOf(m), title: m.name,
    });
    if (shot) openCrop(shot.canvas, shot.rect);
    else closeOverlay();
  } catch (e) {
    closeOverlay();
    toast(`Не удалось открыть камеру (${e.name}). Можно выбрать фото из галереи.`);
  }
}

async function fromFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    // onload, а не img.decode(): decode может не завершиться, пока вкладка в фоне
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    // Большие фото уменьшаем: для распознавания хватает, а работает быстрее
    const k = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    openCrop(c, null);
  } catch {
    toast('Не удалось открыть изображение');
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --- Подгонка рамки ---

function openCrop(src, rect) {
  const m = store.meter(meterId);
  const cropper = new Cropper(src, { drums: m.drums, decimals: m.decimals, aspect: aspectOf(m), rect });
  const angleLabel = h('span', { class: 'angle' }, '0°');
  let frame = 0;
  const slider = h('input', {
    type: 'range', min: -20, max: 20, step: 0.5, value: 0,
    oninput: (e) => {
      const v = +e.target.value;
      angleLabel.textContent = `${v}°`;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => cropper.setAngle(v));
    },
  });
  const screen = h('div', { class: 'screen crop' },
    h('header', { class: 'bar' },
      h('button', { class: 'link', onclick: closeOverlay }, 'Отмена'),
      h('b', {}, m.name),
      h('button', { class: 'link', onclick: () => cropper.fitAll() }, 'Весь снимок')),
    h('p', { class: 'hint' }, rect
      ? 'Подправьте рамку: углы — размер, внутри — сдвиг, два пальца — масштаб.'
      : 'Нажмите на барабаны на фото — рамка переедет туда. Потом подгоните углы.'),
    h('div', { class: 'crop-stage' }, cropper.canvas),
    h('label', { class: 'rot' }, 'Наклон', slider, angleLabel),
    h('footer', { class: 'bar' },
      h('button', {
        class: 'primary wide',
        onclick: () => openConfirm({ strip: cropper.extract(), back: () => showOverlay(screen) }),
      }, 'Распознать')));
  showOverlay(screen);
  requestAnimationFrame(() => cropper.mount(!!rect));
}

// --- Проверка и сохранение показания ---

function openConfirm({ strip, back }) {
  const m = store.meter(meterId);
  const tariffs = store.tariffs();
  const results = strip ? recognize(strip, m.drums, store.templates(m.id)) : null;
  const digits = results ? results.map((r) => r.digit) : [];
  const intLen = m.drums - m.decimals;

  const currentValue = () => {
    if (!results) {
      const v = parseFloat(manualInput.value.replace(',', '.'));
      return Number.isFinite(v) && v >= 0 ? v : null;
    }
    if (digits.some((d) => d == null)) return null;
    const int = digits.slice(0, intLen).join('');
    const dec = digits.slice(intLen).join('');
    return parseFloat(dec ? `${int}.${dec}` : int);
  };

  const inputs = (results || []).map((r, i) => {
    const input = h('input', {
      type: 'text', inputmode: 'numeric', maxlength: 1, value: r.digit, autocomplete: 'off',
      onfocus: (e) => e.target.select(),
      oninput: (e) => {
        const v = e.target.value.replace(/\D/g, '').slice(-1);
        e.target.value = v;
        digits[i] = v === '' ? null : +v;
        e.target.parentElement.classList.remove('low');
        e.target.parentElement.classList.add('edited');
        if (v) inputs[i + 1]?.focus();
        update();
      },
    });
    return input;
  });

  const manualInput = h('input', {
    type: 'text', inputmode: 'decimal', class: 'manual', placeholder: '12345.6', oninput: () => update(),
  });
  const dateInput = h('input', { type: 'date', value: today(), max: today(), onchange: () => update() });
  const summary = h('div', { class: 'summary' });
  let lastIv = null;

  function update() {
    const value = currentValue();
    const d = dateInput.value || today();
    const prev = store.readings(m.id).filter((r) => r.date <= d).at(-1);
    lastIv = value != null && prev ? intervals([prev, { value, date: d }], tariffs, m)[0] : null;
    const lines = [];
    if (value == null) lines.push(h('p', { class: 'muted' }, results ? 'Заполните все цифры' : 'Введите показание'));
    else lines.push(h('p', { class: 'big-value' }, valueOf(m, value), h('small', {}, ' кВт·ч')));
    if (lastIv) {
      lines.push(h('p', {}, `С ${date(prev.date)} (${valueOf(m, prev.value)}): `,
        h('b', {}, `${lastIv.kwh >= 0 ? '+' : ''}${kwh(lastIv.kwh)}`),
        ` за ${lastIv.days} дн. · ${money(lastIv.cost)}`));
      if (lastIv.kwh < 0) lines.push(h('p', { class: 'warn' }, 'Меньше предыдущего показания — проверьте цифры.'));
      else if (lastIv.days > 0 && lastIv.kwh / lastIv.days > 100) {
        lines.push(h('p', { class: 'warn' }, 'Необычно большой расход — проверьте цифры.'));
      }
      if (lastIv.rollover) lines.push(h('p', { class: 'muted' }, 'Учтён переход счётчика через ноль.'));
    } else if (value != null && !prev) {
      lines.push(h('p', { class: 'muted' }, 'Это первое показание: расход посчитается со следующего.'));
    }
    if (results?.some((r, i) => !r.confident && inputs[i].parentElement.classList.contains('low'))) {
      lines.push(h('p', { class: 'warn' }, 'Выделенные цифры распознаны неуверенно — проверьте их.'));
    }
    summary.replaceChildren(...lines);
  }

  function save() {
    const value = currentValue();
    if (value == null) return toast(results ? 'Заполните все цифры' : 'Введите показание');
    if (lastIv?.kwh < 0 && !confirm('Показание меньше предыдущего. Всё равно сохранить?')) return;
    store.addReading({ meterId: m.id, date: dateInput.value || today(), value, source: results ? 'photo' : 'manual' });
    if (results) store.addTemplates(m.id, samplesFrom(results, digits, store.templates(m.id)));
    closeOverlay();
    toast(`Сохранено: ${m.name} — ${valueOf(m, value)} кВт·ч`);
    render();
  }

  const cells = results && h('div', { class: 'cells' }, results.map((r, i) =>
    h('div', { class: ['cellbox', i >= intLen && 'dec', !r.confident && 'low'].filter(Boolean).join(' ') },
      r.preview, inputs[i])));

  showOverlay(h('div', { class: 'screen confirm' },
    h('header', { class: 'bar' },
      h('button', { class: 'link', onclick: back || closeOverlay }, back ? '← Рамка' : 'Отмена'),
      h('b', {}, m.name),
      h('span', {})),
    h('div', { class: 'confirm-body' },
      strip && h('div', { class: 'strip' }, strip),
      cells || h('label', { class: 'field' }, 'Показание, кВт·ч', manualInput),
      results && h('p', { class: 'muted small' }, 'Нажмите на цифру, чтобы исправить. Подтверждённые цифры запоминаются, и распознавание этого счётчика становится точнее.'),
      h('label', { class: 'field' }, 'Дата показания', dateInput),
      summary),
    h('footer', { class: 'bar' }, h('button', { class: 'primary wide', onclick: save }, 'Сохранить'))));
  update();
  if (!results) manualInput.focus();
}

// --- История ---

function viewHistory() {
  const tariffs = store.tariffs();
  const rows = [];
  for (const m of store.meters()) {
    if (historyFilter !== 'all' && historyFilter !== m.id) continue;
    const rs = store.readings(m.id);
    const ivs = new Map(intervals(rs, tariffs, m).map((iv) => [iv.reading.id, iv]));
    for (const r of rs) rows.push({ r, m, iv: ivs.get(r.id) });
  }
  rows.sort((a, b) => b.r.date.localeCompare(a.r.date) || b.r.createdAt.localeCompare(a.r.createdAt));

  return [
    h('h1', {}, 'Показания'),
    meterChips(historyFilter, (id) => { historyFilter = id; render(); }, true),
    rows.length
      ? h('ul', { class: 'list' }, rows.map(({ r, m, iv }) => h('li', { class: 'item' },
        h('div', { class: 'item-main' },
          h('div', {}, h('b', {}, valueOf(m, r.value)), h('span', { class: 'muted' }, ' кВт·ч')),
          h('div', { class: 'muted small' }, `${date(r.date)} · ${m.name}${r.source === 'photo' ? ' · 📷' : ''}`)),
        iv && h('div', { class: 'item-side' + (iv.kwh < 0 ? ' bad' : '') },
          h('b', {}, `${iv.kwh >= 0 ? '+' : ''}${kwh(iv.kwh)}`),
          h('div', { class: 'small' }, money(iv.cost))),
        h('button', {
          class: 'icon', title: 'Удалить', onclick: () => {
            if (!confirm(`Удалить показание ${valueOf(m, r.value)} от ${date(r.date)}?`)) return;
            store.removeReading(r.id);
            render();
          },
        }, '🗑'))))
      : h('p', { class: 'empty' }, 'Показаний пока нет.'),
  ];
}

// --- Статистика ---

function barChart(values, labels, unit) {
  const W = 360, H = 170, top = 18, bottom = 22, gap = 6;
  const max = Math.max(...values, 0) || 1;
  const bw = (W - gap * (values.length + 1)) / values.length;
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
  values.forEach((v, i) => {
    const x = gap + i * (bw + gap);
    const bh = ((H - top - bottom) * v) / max;
    const bar = el('rect', { x, y: H - bottom - bh, width: bw, height: Math.max(bh, v ? 1 : 0), rx: 3, class: 'bar' });
    bar.append(el('title', {}, `${labels[i]}: ${v ? fmt(v, unit === 'money' ? 2 : 1) : '—'}`));
    svg.append(bar);
    svg.append(el('text', { x: x + bw / 2, y: H - 6, class: 'axis' }, labels[i].slice(0, 3)));
  });
  svg.append(el('text', { x: W - 2, y: 11, class: 'axis max' }, `макс. ${unit === 'money' ? money(max) : kwh(max)}`));
  return svg;
}

function viewStats() {
  const meters = store.meters();
  const tariffs = store.tariffs();
  const monthly = aggregate(meters, store.readings, tariffs, byMonth);
  const yearly = aggregate(meters, store.readings, tariffs, byYear);
  const years = [...yearly.keys()];
  const out = [h('h1', {}, 'Статистика'), ...paymentStats()];
  if (!years.length) {
    out.push(h('h2', {}, 'Расход по показаниям'),
      h('p', { class: 'muted' }, 'Нужно хотя бы два показания одного счётчика, чтобы посчитать расход.'));
    return out;
  }
  if (!years.includes(statsYear)) statsYear = years.at(-1);

  const y = yearly.get(statsYear);
  const months = MONTHS.map((name, i) => [name, monthly.get(`${statsYear}-${pad(i + 1)}`)]);
  const active = months.filter(([, v]) => v).length || 1;
  const byCost = !y.missingCost && tariffs.length > 0;
  const costCell = (row) => (row && !row.missingCost ? money(row.cost) : '—');

  out.push(
    h('h2', {}, 'Расход по показаниям'),
    chips(years.map((yr) => [yr, yr]), statsYear, (yr) => { statsYear = yr; render(); }),
    !tariffs.length && h('p', { class: 'warn' }, 'Добавьте тариф в настройках, чтобы считать стоимость.'),
    y.missingCost && tariffs.length > 0 &&
      h('p', { class: 'warn' }, 'Для части периодов нет тарифа — суммы неполные. Добавьте тариф с более ранней даты.'),
    h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('small', {}, 'Расход за год'), h('b', {}, kwh(y.kwh))),
      h('div', { class: 'tile' }, h('small', {}, 'Стоимость за год'), h('b', {}, costCell(y))),
      h('div', { class: 'tile' }, h('small', {}, 'В среднем за месяц'), h('b', {}, kwh(Math.round((y.kwh / active) * 10) / 10))),
      h('div', { class: 'tile' }, h('small', {}, 'Средняя стоимость в месяц'), h('b', {}, y.missingCost ? '—' : money(y.cost / active)))),
    h('section', { class: 'card' },
      h('div', { class: 'card-title' }, byCost ? 'Стоимость по месяцам' : 'Расход по месяцам, кВт·ч'),
      barChart(months.map(([, v]) => (v ? (byCost ? v.cost : v.kwh) : 0)), months.map(([n]) => n), byCost ? 'money' : 'kwh')),
    h('p', { class: 'muted small' }, 'Расход в кВт·ч. Интервал относится к месяцу, когда снято закрывающее показание.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Месяц'), meters.map((m) => h('th', {}, m.name)), h('th', {}, 'Всего'), h('th', {}, 'Сумма'))),
      h('tbody', {}, months.filter(([, v]) => v).map(([name, v]) => h('tr', {},
        h('td', {}, name),
        meters.map((m) => h('td', {}, v.meters[m.id] ? num(v.meters[m.id].kwh) : '—')),
        h('td', {}, num(v.kwh)),
        h('td', {}, costCell(v))))),
      h('tfoot', {}, h('tr', {},
        h('td', {}, 'Итого'),
        meters.map((m) => h('td', {}, y.meters[m.id] ? num(y.meters[m.id].kwh) : '—')),
        h('td', {}, num(y.kwh)),
        h('td', {}, costCell(y)))))));
  return out;
}

// Оплаты и взносы по годам — как итоги в таблице пользователя
function paymentStats() {
  const meters = store.meters();
  const ids = statsMeter === 'all' ? meters.map((m) => m.id) : [statsMeter];
  const pays = ids.flatMap((id) => store.list('payments', id));
  const dues = ids.flatMap((id) => store.list('dues', id));
  if (!store.list('payments').length && !store.list('dues').length) return [];
  const years = paymentYears(pays, dues);
  const total = [...years.values()].reduce((t, r) => {
    for (const k of Object.keys(t)) t[k] += r[k];
    return t;
  }, { amount: 0, commission: 0, net: 0, kwh: 0, dues: 0, count: 0 });
  return [
    h('h2', {}, 'Оплаты по годам'),
    meterChips(statsMeter, (id) => { statsMeter = id; render(); }, true),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Год', 'Заплачено', 'Комиссия', 'Дошло', 'кВт', 'Взносы'].map((t) => h('th', {}, t)))),
      h('tbody', {}, [...years.entries()].reverse().map(([yr, r]) => h('tr', {},
        h('td', {}, yr), h('td', {}, fmt(r.amount, 2)), h('td', {}, fmt(r.commission, 2)),
        h('td', {}, fmt(r.net, 2)), h('td', {}, num(Math.round(r.kwh * 10) / 10)), h('td', {}, r.dues ? fmt(r.dues, 2) : '—')))),
      h('tfoot', {}, h('tr', {},
        h('td', {}, 'Итого'), h('td', {}, fmt(total.amount, 2)), h('td', {}, fmt(total.commission, 2)),
        h('td', {}, fmt(total.net, 2)), h('td', {}, num(Math.round(total.kwh * 10) / 10)), h('td', {}, fmt(total.dues, 2)))))),
    h('p', { class: 'muted small' }, `Суммы в ${store.settings().currency || 'валюте из настроек'}. кВт — сколько оплачено.`),
  ];
}

// --- Загрузка из таблиц: предпросмотр изменений ---

function describe(kind, f, meterName) {
  const when = date(f.date || f.from);
  const where = meterName ? ` · ${meterName}` : '';
  const what = {
    payments: () => `💳 ${money(f.amount)} · тариф ${price(f.tariff)}`,
    adjustments: () => `⚖️ сверка: оплачено по ${num(f.paidTo)}`,
    dues: () => `🧾 взнос ${money(f.amount)}`,
    readings: () => `📷 показание ${num(f.value)}`,
    tariffs: () => `тариф ${price(f.price)} за кВт·ч`,
  }[kind]();
  return `${when}${where} · ${what}${f.comment ? ` · ${f.comment}` : ''}`;
}

const showValue = (field, v) => {
  if (v == null || v === '') return 'пусто';
  if (field === 'meterId') return store.meter(v)?.name || String(v).replace(/^new:/, '');
  if (field === 'date' || field === 'from') return date(v);
  return typeof v === 'number' ? price(v) : `«${v}»`;
};

function previewList(title, items, render1, { cls = '', limit = 40 } = {}) {
  if (!items.length) return null;
  return h('section', { class: `card ${cls}` },
    h('div', { class: 'card-title' }, `${title}: ${items.length}`),
    h('ul', { class: 'plain' }, items.slice(0, limit).map((x) => h('li', {}, render1(x))),
      items.length > limit && h('li', { class: 'muted' }, `…и ещё ${items.length - limit}`)));
}

function openPreview({ source, d, errors = [], notes = [], main = null, snapshot = null, onApplied }) {
  let applyRemoved = true;
  const nameOf = (x) => store.meter(x.rec?.meterId || '')?.name || '';
  const mainIssues = main && snapshot ? checkMain(main, snapshot) : [];
  const nothing = !d.added.length && !d.changed.length && !d.removed.length && !d.meters.some((p) => !p.id || p.rename);

  const removedToggle = d.removed.length && h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: true, onchange: (e) => (applyRemoved = e.target.checked) }),
    ' Удалить их и в приложении');

  showOverlay(h('div', { class: 'screen confirm' },
    h('header', { class: 'bar' },
      h('button', { class: 'link', onclick: closeOverlay }, 'Отмена'),
      h('b', {}, 'Предпросмотр изменений'),
      h('span', {})),
    h('div', { class: 'confirm-body' },
      h('p', { class: 'muted small' }, `Источник: ${source}`),
      h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('small', {}, 'Новые'), h('b', {}, d.added.length)),
        h('div', { class: 'tile' }, h('small', {}, 'Изменено'), h('b', {}, d.changed.length)),
        h('div', { class: 'tile' }, h('small', {}, 'Удалено в таблице'), h('b', {}, d.removed.length)),
        h('div', { class: 'tile' }, h('small', {}, 'Только в приложении'), h('b', {}, d.onlyApp.length))),
      nothing && h('p', { class: 'ok' }, 'Данные в таблице и в приложении совпадают.'),
      d.meters.filter((p) => !p.id || p.rename).length > 0 && h('section', { class: 'card' },
        h('div', { class: 'card-title' }, 'Гаражи'),
        h('ul', { class: 'plain' }, d.meters.filter((p) => !p.id || p.rename).map((p) => h('li', {},
          p.id ? `«${store.meter(p.id).name}» будет переименован в «${p.name}»` : `Новый гараж «${p.name}»`)))),
      mainIssues.length > 0 && h('section', { class: 'card warn-card' },
        h('div', { class: 'card-title' }, `Во вкладке «${MAIN}» есть правки, которых нет в «${DATA}»`),
        h('p', { class: 'small' }, `Они не будут загружены. Перенесите их во вкладку «${DATA}» или внесите в приложении.`),
        h('ul', { class: 'plain small' }, mainIssues.map((x) => h('li', {}, `${x.ref}: должно быть ${x.expected}, в таблице ${x.actual}`)))),
      errors.length > 0 && previewList('Строки, которые не удалось прочитать', errors, (e) => e, { cls: 'warn-card' }),
      previewList('Новые', d.added, (a) => describe(a.kind, a.fields, a.meterName)),
      previewList('Изменено', d.changed, (c) => [
        describe(c.kind, c.before, nameOf({ rec: c.before })),
        h('div', { class: 'small changes' }, c.changes.map((x) =>
          `${FIELD_NAMES[x.field]}: ${showValue(x.field, x.from)} → ${showValue(x.field, x.to)}`).join('; ')),
      ]),
      d.removed.length > 0 && h('section', { class: 'card' },
        h('div', { class: 'card-title' }, `Удалено в таблице: ${d.removed.length}`),
        h('ul', { class: 'plain' }, d.removed.slice(0, 40).map((x) => h('li', {}, describe(x.kind, x.rec, nameOf(x))))),
        removedToggle),
      previewList('Есть только в приложении (останутся и попадут в таблицу при следующей выгрузке)', d.onlyApp,
        (x) => describe(x.kind, x.rec, nameOf(x)), { limit: 15 }),
      notes.length > 0 && previewList('Что исправлено при чтении', notes, (n) => n, { limit: 60 })),
    h('footer', { class: 'bar' },
      h('button', {
        class: 'primary wide', onclick: () => {
          applyDiff(d, { applyRemoved });
          store.markSynced();
          onApplied?.();
          closeOverlay();
          toast(nothing ? 'Изменений нет' : 'Изменения применены');
          render();
        },
      }, nothing ? 'Готово' : 'Применить'))));
}

async function importXlsxFile(file) {
  try {
    const book = await readXlsx(await file.arrayBuffer());
    if (book.names.includes(DATA)) {
      const { records, errors } = parseData(book.sheet(DATA));
      openPreview({
        source: file.name, d: diff(records), errors,
        main: book.sheet(MAIN), snapshot: book.sheet(SNAPSHOT),
      });
    } else {
      // Старая таблица пользователя (до MeterMate): разбор раскладки
      const { records, notes } = parseLegacy(book.sheet(book.names[0]), today());
      openPreview({
        source: `${file.name} — старый формат, импорт истории`,
        d: diff(records, { detectRemoved: false, renameDefaults: true }), notes,
      });
    }
  } catch (e) {
    console.error(e);
    toast(e.message || 'Не удалось прочитать файл');
  }
}

async function importGoogle() {
  toast('Загружаю из Google Таблицы…');
  try {
    const { main, data, snapshot, hash } = await google.pull();
    if (data.length < 2) {
      google.rememberHash(hash);
      toast('Во вкладке «Данные» пусто — отправьте данные из приложения');
      return;
    }
    const { records, errors } = parseData(data);
    openPreview({
      source: 'Google Таблица', d: diff(records), errors, main, snapshot,
      onApplied: () => google.rememberHash(hash),
    });
  } catch (e) {
    toast(e.message);
  }
}

async function pushGoogle(force = false) {
  toast('Отправляю в Google Таблицу…');
  try {
    const res = await google.push({ force });
    toast(res.conflict ? 'В таблице изменили «Данные» — сначала загрузите изменения' : 'Отправлено в Google Таблицу');
  } catch (e) {
    store.setGoogle({ error: e.message });
    toast(e.message);
  }
  render();
}

// --- Настройки ---

function select(options, current, onchange) {
  return h('select', { onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(current) }, label)));
}

const fileButton = (label, accept, onFile, cls) => {
  const input = h('input', {
    type: 'file', accept, hidden: true,
    onchange: (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) onFile(f);
    },
  });
  return [h('button', { class: cls, onclick: () => input.click() }, label), input];
};

function googleSection() {
  const g = store.google();
  const url = h('input', { type: 'url', value: g.url, placeholder: 'https://script.google.com/macros/s/…/exec' });
  const token = h('input', { type: 'password', value: g.token, placeholder: 'ключ доступа (TOKEN из скрипта)', autocomplete: 'off' });
  const saveConn = () => store.setGoogle({ url: url.value.trim(), token: token.value.trim(), hash: '', error: '' });
  url.addEventListener('change', saveConn);
  token.addEventListener('change', saveConn);
  const makeToken = async () => {
    if (token.value && !confirm('Заменить ключ? Его нужно будет обновить и в свойствах скрипта (TOKEN).')) return;
    token.value = google.newToken();
    saveConn();
    try {
      await navigator.clipboard.writeText(token.value);
      toast('Ключ создан и скопирован — вставьте его в свойство TOKEN скрипта');
    } catch {
      token.type = 'text';
      toast('Ключ создан — скопируйте его в свойство TOKEN скрипта');
    }
  };
  const status = g.error
    ? h('p', { class: 'warn' }, g.error)
    : g.pending
      ? h('p', { class: 'muted small' }, 'Есть изменения, ждут отправки')
      : g.at
        ? h('p', { class: 'ok' }, `Синхронизировано: ${new Date(g.at).toLocaleString('ru-RU')}`)
        : null;
  return [
    h('h2', {}, 'Google Таблицы'),
    h('p', { class: 'muted small' },
      'Необязательно. Приложение пишет в вашу Google Таблицу вкладки «Гаражи» и «Данные» и умеет загружать правки из «Данных». ',
      'Как подключить — в README проекта, раздел «Google Таблицы». Данные при этом хранятся и в Google.'),
    h('section', { class: 'card' },
      field('Адрес скрипта', url),
      field('Ключ доступа', token),
      h('button', { class: 'link', onclick: makeToken }, '🔑 Создать надёжный ключ'),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: g.auto, onchange: (e) => store.setGoogle({ auto: e.target.checked }) }),
        ' Отправлять автоматически после каждого изменения'),
      status,
      g.url && h('div', { class: 'buttons' },
        h('button', { onclick: () => pushGoogle() }, '⬆️ Отправить'),
        h('button', { onclick: importGoogle }, '⬇️ Загрузить'),
        g.error?.includes('изменили') && h('button', {
          class: 'link bad', onclick: () => {
            if (confirm('Перезаписать Google Таблицу данными из приложения? Правки, сделанные в таблице, пропадут.')) pushGoogle(true);
          },
        }, 'Перезаписать таблицу'))),
  ];
}

function viewSettings() {
  const meters = store.meters();
  const tariffs = store.tariffs();
  const tariffDate = h('input', { type: 'date', value: today() });
  const tariffPrice = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Цена за кВт·ч' });
  let tariffMeter = '';

  return [
    h('h1', {}, 'Настройки'),

    h('h2', {}, 'Счётчики'),
    meters.map((m) => h('section', { class: 'card' },
      h('label', { class: 'field' }, 'Название',
        h('input', { type: 'text', value: m.name, onchange: (e) => store.updateMeter(m.id, { name: e.target.value.trim() || m.name }) })),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Барабанов всего',
          select([4, 5, 6, 7, 8].map((n) => [n, n]), m.drums, (v) => {
            store.updateMeter(m.id, { drums: +v, decimals: Math.min(m.decimals, +v - 1) });
            render();
          })),
        h('label', { class: 'field' }, 'Из них после запятой',
          select([0, 1, 2].map((n) => [n, n]), m.decimals, (v) => { store.updateMeter(m.id, { decimals: +v }); render(); }))),
      h('div', { class: 'row muted small' },
        `Образцов цифр: ${store.templateCount(m.id)}`,
        h('button', {
          class: 'link', onclick: () => {
            if (confirm(`Забыть выученные цифры счётчика «${m.name}»?`)) { store.resetTemplates(m.id); render(); }
          },
        }, 'Сбросить обучение'),
        meters.length > 1 && h('button', {
          class: 'link bad', onclick: () => {
            if (confirm(`Удалить счётчик «${m.name}» вместе с его записями из списков?`)) { store.removeMeter(m.id); render(); }
          },
        }, 'Удалить')))),
    h('button', { class: 'ghost', onclick: () => { store.addMeter(`Счётчик ${meters.length + 1}`); render(); } }, '+ Добавить счётчик'),

    h('h2', {}, 'Тарифы'),
    h('p', { class: 'muted small' },
      'Цена за 1 кВт·ч. Тариф действует с указанной даты до появления следующего; тариф конкретного счётчика важнее общего. ',
      'Текущий тариф подставляется в новые оплаты, а прошлые оплаты хранят свой тариф и не пересчитываются.'),
    tariffs.length
      ? h('ul', { class: 'list' }, tariffs.map((t) => h('li', { class: 'item' },
        h('div', { class: 'item-main' },
          h('b', {}, `${price(t.price)} ${store.settings().currency} за кВт·ч`),
          h('div', { class: 'muted small' }, `с ${date(t.from)} · ${t.meterId ? store.meter(t.meterId)?.name : 'все счётчики'}`)),
        h('button', { class: 'icon', title: 'Удалить', onclick: () => { store.removeTariff(t.id); render(); } }, '🗑'))))
      : h('p', { class: 'muted' }, 'Тарифов пока нет.'),
    h('section', { class: 'card' },
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Действует с', tariffDate),
        h('label', { class: 'field' }, 'Цена', tariffPrice)),
      h('label', { class: 'field' }, 'Для счётчика',
        select([['', 'Все счётчики'], ...meters.map((m) => [m.id, m.name])], '', (v) => (tariffMeter = v))),
      h('button', {
        class: 'primary', onclick: () => {
          const value = parseNum(tariffPrice.value);
          if (!(value > 0) || !tariffDate.value) return toast('Укажите дату и цену');
          store.addTariff({ from: tariffDate.value, price: value, meterId: tariffMeter });
          render();
        },
      }, 'Добавить тариф')),

    h('h2', {}, 'Оплаты'),
    h('div', { class: 'row' },
      field('Валюта', h('input', {
        type: 'text', value: store.settings().currency, placeholder: 'BYN', maxlength: 6,
        onchange: (e) => store.setSetting('currency', e.target.value.trim()),
      })),
      field('Комиссия по умолчанию, %', decimalInput(store.settings().commission, {
        onchange: (e) => {
          const v = parseNum(e.target.value);
          if (v != null && v >= 0 && v < 100) store.setSetting('commission', v);
        },
      }))),

    h('h2', {}, 'Таблица'),
    h('p', { class: 'muted small' },
      `Файл .xlsx с вкладками «${MAIN}» (как ваша таблица, с формулами) и «${DATA}» (список записей). `,
      `Загрузка читает «${DATA}» и сначала показывает, что изменится. Можно загрузить и старую таблицу — история перенесётся.`),
    h('div', { class: 'actions' },
      h('button', {
        onclick: () => {
          deliver(workbook(), `metermate-${today()}.xlsx`);
          store.markSynced();
        },
      }, '📗 Скачать таблицу (.xlsx)'),
      fileButton('📂 Загрузить из таблицы (.xlsx)', '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', importXlsxFile)),

    googleSection(),

    h('h2', {}, 'Резервная копия'),
    h('div', { class: 'actions' },
      h('button', { onclick: () => deliver(backup(), `metermate-backup-${today()}.json`) }, '💾 Сохранить копию (.json)'),
      fileButton('📥 Загрузить копию (.json)', '.json,application/json', async (f) => {
        try {
          const n = store.merge(JSON.parse(await f.text()));
          toast(n ? `Готово: добавлено или обновлено записей — ${n}` : 'Новых данных в файле нет');
          render();
        } catch (err) {
          toast(err.message || 'Не удалось прочитать файл');
        }
      }, 'ghost')),
    h('p', { class: 'muted small' },
      'Полная копия, включая выученные цифры. Подходит для переноса на другое устройство: данные объединяются без дублей.'),
    h('p', { class: 'muted small' }, `MeterMate ${VERSION}. Данные хранятся на этом устройстве${store.google().url ? ' и в вашей Google Таблице' : ''}.`),
  ];
}

// --- Каркас ---

function render() {
  const views = { home: viewHome, payments: viewPayments, history: viewHistory, stats: viewStats, settings: viewSettings };
  $view.replaceChildren(...[views[tab]()].flat(Infinity).filter(Boolean));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
}

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  render();
  window.scrollTo(0, 0);
}));

// Изменения данных → автоотправка в Google Таблицу (если подключена)
store.onChange(() => google.schedule());
google.onStatus(() => { if (tab === 'settings' && $overlay.hidden) render(); });
google.flush();

// На localhost без service worker, чтобы правки кода было видно сразу
if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  navigator.serviceWorker.register('sw.js');
}
navigator.storage?.persist?.();

render();

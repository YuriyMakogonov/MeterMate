import * as store from './store.js';
import { h } from './dom.js';
import { openCamera } from './camera.js';
import { Cropper } from './cropper.js';
import { recognize, samplesFrom } from './recognizer.js';
import { intervals, aggregate, byMonth, byYear, priceOn } from './stats.js';
import { workbook, backup } from './export.js';

const VERSION = '0.1.0';

const $view = document.getElementById('view');
const $overlay = document.getElementById('overlay');
const $toast = document.getElementById('toast');

let tab = 'home';
let meterId = store.meters()[0]?.id;
let historyFilter = 'all';
let statsYear = null;

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
  const tariffs = store.tariffs();
  const rs = store.readings(m.id);
  const last = rs.at(-1);
  const iv = intervals(rs, tariffs, m).at(-1);
  const price = priceOn(tariffs, m.id, today());
  return h('section', { class: 'card' },
    h('div', { class: 'card-title' }, m.name),
    last
      ? h('div', { class: 'reading' }, valueOf(m, last.value), h('small', {}, ` кВт·ч · ${date(last.date)}`))
      : h('div', { class: 'muted' }, 'Показаний пока нет'),
    iv && h('div', {}, `За ${iv.days} дн.: ${kwh(iv.kwh)} · ${money(iv.cost)}`),
    h('div', { class: 'muted small' },
      price == null ? 'Тариф не задан — добавьте в настройках' : `Тариф: ${money(price)} за кВт·ч`,
      ` · образцов цифр: ${store.templateCount(m.id)}`));
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
    img.src = url;
    await img.decode();
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
    h('h1', {}, 'История'),
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
  if (!years.length) {
    return [h('h1', {}, 'Статистика'),
      h('p', { class: 'empty' }, 'Нужно хотя бы два показания одного счётчика, чтобы посчитать расход.')];
  }
  if (!years.includes(statsYear)) statsYear = years.at(-1);

  const y = yearly.get(statsYear);
  const months = MONTHS.map((name, i) => [name, monthly.get(`${statsYear}-${pad(i + 1)}`)]);
  const active = months.filter(([, v]) => v).length || 1;
  const byCost = !y.missingCost && tariffs.length > 0;
  const costCell = (row) => (row && !row.missingCost ? money(row.cost) : '—');

  return [
    h('h1', {}, 'Статистика'),
    chips(years.map((yr) => [yr, yr]), statsYear, (yr) => { statsYear = yr; render(); }),
    !tariffs.length && h('p', { class: 'warn' }, 'Добавьте тариф в настройках, чтобы считать стоимость.'),
    y.missingCost && tariffs.length > 0 &&
      h('p', { class: 'warn' }, 'Для части периодов нет тарифа — суммы неполные. Добавьте тариф с более ранней даты.'),
    h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('small', {}, 'Расход за год'), h('b', {}, kwh(y.kwh))),
      h('div', { class: 'tile' }, h('small', {}, 'Сумма за год'), h('b', {}, costCell(y))),
      h('div', { class: 'tile' }, h('small', {}, 'В среднем за месяц'), h('b', {}, kwh(Math.round((y.kwh / active) * 10) / 10))),
      h('div', { class: 'tile' }, h('small', {}, 'Средняя сумма в месяц'), h('b', {}, y.missingCost ? '—' : money(y.cost / active)))),
    h('section', { class: 'card' },
      h('div', { class: 'card-title' }, byCost ? 'Сумма по месяцам' : 'Расход по месяцам, кВт·ч'),
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
        h('td', {}, costCell(y)))))),
    years.length > 1 && h('h2', {}, 'По годам'),
    years.length > 1 && h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Год'), h('th', {}, 'Расход'), h('th', {}, 'Сумма'))),
      h('tbody', {}, years.map((yr) => h('tr', {},
        h('td', {}, yr), h('td', {}, num(yearly.get(yr).kwh)), h('td', {}, costCell(yearly.get(yr)))))))),
  ];
}

// --- Настройки ---

function select(options, current, onchange) {
  return h('select', { onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(current) }, label)));
}

function viewSettings() {
  const meters = store.meters();
  const tariffs = store.tariffs();
  const tariffDate = h('input', { type: 'date', value: today() });
  const tariffPrice = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Цена за кВт·ч' });
  let tariffMeter = '';
  const importInput = h('input', {
    type: 'file', accept: '.json,application/json', hidden: true,
    onchange: async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const n = store.merge(JSON.parse(await f.text()));
        toast(n ? `Готово: добавлено или обновлено записей — ${n}` : 'Новых данных в файле нет');
        render();
      } catch (err) {
        toast(err.message || 'Не удалось прочитать файл');
      }
    },
  });

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
            if (confirm(`Удалить счётчик «${m.name}» вместе с его показаниями из списков?`)) { store.removeMeter(m.id); render(); }
          },
        }, 'Удалить')))),
    h('button', { class: 'ghost', onclick: () => { store.addMeter(`Счётчик ${meters.length + 1}`); render(); } }, '+ Добавить счётчик'),

    h('h2', {}, 'Тарифы'),
    h('p', { class: 'muted small' }, 'Цена за 1 кВт·ч. Тариф действует с указанной даты до появления следующего. Тариф конкретного счётчика важнее общего.'),
    tariffs.length
      ? h('ul', { class: 'list' }, tariffs.map((t) => h('li', { class: 'item' },
        h('div', { class: 'item-main' },
          h('b', {}, `${money(t.price)} за кВт·ч`),
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
          const price = parseFloat(tariffPrice.value.replace(',', '.'));
          if (!(price > 0) || !tariffDate.value) return toast('Укажите дату и цену');
          store.addTariff({ from: tariffDate.value, price, meterId: tariffMeter });
          render();
        },
      }, 'Добавить тариф')),

    h('h2', {}, 'Валюта'),
    h('input', {
      type: 'text', value: store.settings().currency, placeholder: 'например ₽, ₴, €, $', maxlength: 6,
      onchange: (e) => store.setSetting('currency', e.target.value.trim()),
    }),

    h('h2', {}, 'Данные'),
    h('div', { class: 'actions' },
      h('button', { onclick: () => deliver(workbook(), `metermate-${today()}.xlsx`) }, '📗 Выгрузить в Excel (.xlsx)'),
      h('button', { onclick: () => deliver(backup(), `metermate-backup-${today()}.json`) }, '💾 Сохранить резервную копию'),
      h('button', { class: 'ghost', onclick: () => importInput.click() }, '📥 Загрузить резервную копию'),
      importInput),
    h('p', { class: 'muted small' },
      'Перенос на другое устройство: сохраните резервную копию, передайте файл (iCloud, Google Drive, Telegram…) ',
      'и загрузите на другом устройстве. Данные объединяются без дублей, удаления тоже переносятся.'),
    h('p', { class: 'muted small' }, `MeterMate ${VERSION}. Все данные хранятся только на этом устройстве.`),
  ];
}

// --- Каркас ---

function render() {
  const views = { home: viewHome, history: viewHistory, stats: viewStats, settings: viewSettings };
  $view.replaceChildren(...[views[tab]()].flat(Infinity).filter(Boolean));
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
}

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab;
  render();
  window.scrollTo(0, 0);
}));

// На localhost без service worker, чтобы правки кода было видно сразу
if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  navigator.serviceWorker.register('sw.js');
}
navigator.storage?.persist?.();

render();

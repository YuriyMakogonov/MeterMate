// Выгрузка в Excel (.xlsx) и резервная копия (.json).

import * as store from './store.js';
import { intervals, aggregate, byMonth, byYear } from './stats.js';
import { buildXlsx } from './xlsx.js';

const bold = (v) => ({ v, style: 'bold' });
const money = (v) => (v == null ? '' : { v: Math.round(v * 100) / 100, style: 'money' });
const num = (v) => ({ v, style: 'num' });

function periodSheet(name, title, meters, data) {
  const head = [bold(title)];
  for (const m of meters) head.push(bold(`${m.name}, кВт·ч`), bold(`${m.name}, сумма`));
  head.push(bold('Итого, кВт·ч'), bold('Итого, сумма'));
  const rows = [head];
  for (const [key, row] of data) {
    const line = [key];
    for (const m of meters) {
      const mm = row.meters[m.id];
      line.push(mm ? num(mm.kwh) : '', mm && !mm.missingCost ? money(mm.cost) : '');
    }
    line.push(num(row.kwh), row.missingCost ? '' : money(row.cost));
    rows.push(line);
  }
  return { name, rows, widths: [12, ...meters.flatMap(() => [16, 16]), 14, 14] };
}

export function workbook() {
  const meters = store.meters();
  const tariffs = store.tariffs();

  const readingRows = [[bold('Дата'), bold('Счётчик'), bold('Показание'), bold('Расход, кВт·ч'),
    bold('Дней'), bold('Средний тариф'), bold('Стоимость')]];
  const lines = [];
  for (const m of meters) {
    const rs = store.readings(m.id);
    const ivs = new Map(intervals(rs, tariffs, m).map((iv) => [iv.reading.id, iv]));
    for (const r of rs) lines.push({ r, m, iv: ivs.get(r.id) });
  }
  lines.sort((a, b) => a.r.date.localeCompare(b.r.date) || a.m.name.localeCompare(b.m.name));
  for (const { r, m, iv } of lines) {
    readingRows.push([
      r.date, m.name, num(r.value),
      iv ? num(iv.kwh) : '', iv ? iv.days : '',
      iv?.cost != null && iv.kwh > 0 ? money(iv.cost / iv.kwh) : '',
      iv ? money(iv.cost) : '',
    ]);
  }

  const tariffRows = [[bold('Действует с'), bold('Счётчик'), bold('Цена за кВт·ч')]];
  for (const t of tariffs) {
    tariffRows.push([t.from, t.meterId ? store.meter(t.meterId)?.name : 'Все счётчики', money(t.price)]);
  }

  return buildXlsx([
    { name: 'Показания', rows: readingRows, widths: [12, 18, 12, 14, 8, 15, 12] },
    periodSheet('По месяцам', 'Месяц', meters, aggregate(meters, store.readings, tariffs, byMonth)),
    periodSheet('По годам', 'Год', meters, aggregate(meters, store.readings, tariffs, byYear)),
    { name: 'Тарифы', rows: tariffRows, widths: [14, 18, 14] },
  ]);
}

export const backup = () =>
  new Blob([JSON.stringify(store.snapshot(), null, 1)], { type: 'application/json' });

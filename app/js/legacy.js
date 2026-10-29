// Импорт истории из «старой» таблицы пользователя (до MeterMate):
// один лист, гаражи блоками с заголовком «дата | Платеж/сумма | Комиссия % | …»,
// взносы в колонках M–O, подпись гаража («1й гараж») в колонке Q.
//
// Строка с платежом → оплата. Если «счётчик до оплаты» не совпадает с
// «оплачен по» предыдущей строки (ручная правка) → перед оплатой сверка.
// Строки без платежа («Сверены показания…», «ПОКУПКА», «БУХ данные») → сверка.
// Пометки в J/K (числа и текст) → комментарии. Итоги по годам не переносятся.

import { parseDate, parseNum } from './sheets.js';

const B = 1, C = 2, D = 3, F = 5, H = 7, I = 8, J = 9, K = 10, M = 12, N = 13, O = 14, Q = 16;

const text = (cell) => (cell && typeof cell.v === 'string' ? cell.v.trim() : '');
const num = (cell) => (cell && typeof cell.v === 'number' ? cell.v : null);
// Число, вписанное руками (не результат формулы)
const constNum = (cell) => (cell && !cell.f && typeof cell.v === 'number' ? cell.v : null);
const fmt = (n) => String(Math.round(n * 100) / 100).replace('.', ',');

function isHeader(row) {
  return /дата/i.test(text(row[B])) && /(платеж|платёж|сумма)/i.test(text(row[C]));
}

// Итоговая строка блока: в C формула SUM(...)
const isTotal = (row) => /^SUM\(/i.test(row[C]?.f || '');

/**
 * @param grid — лист из readXlsx (ячейки { v, f })
 * @param today — ISO-дата, «сегодня» (для исправления дат из будущего)
 * @returns { records, notes } — записи в формате parseData и заметки об исправлениях
 */
export function parseLegacy(grid, today) {
  const starts = [];
  grid.forEach((row, r) => { if (row && isHeader(row)) starts.push(r); });
  if (!starts.length) throw new Error('Не нашёл в таблице блоков с заголовком «дата | Платеж | Комиссия %»');

  const records = [], notes = [];
  starts.forEach((start, bi) => {
    const end = bi + 1 < starts.length ? starts[bi + 1] : grid.length;
    let meterName = `Гараж ${bi + 1}`;
    for (let r = start; r < end; r++) {
      const label = text(grid[r]?.[Q]);
      if (/гараж/i.test(label)) meterName = label;
    }

    let paidTo = null, lastDate = null, maxDate = null, order = 0;
    const pendingAdj = []; // сверки без даты ждут даты соседней строки
    const id = (row, kind) => `legacy:${bi + 1}:${row + 1}:${kind}`;
    const push = (kind, row, fields) => records.push({ kind, id: id(row, kind), meterName, fields, order: order++ });

    const dateAt = (cell, r) => {
      let iso = parseDate(typeof cell?.v === 'string' ? cell.v : num(cell));
      if (!iso) return null;
      if (iso > today) {
        // «08,11,27» между 2024 и 2025 — опечатка в годе
        const fixed = `${(lastDate || today).slice(0, 4)}${iso.slice(4)}`;
        notes.push(`${meterName}, строка ${r + 1}: дата ${iso.split('-').reverse().join('.')} из будущего → ${fixed.split('-').reverse().join('.')}`);
        iso = fixed < (lastDate || '') ? `${+fixed.slice(0, 4) + 1}${fixed.slice(4)}` : fixed;
      }
      return iso;
    };

    const flushAdj = (date) => {
      for (const a of pendingAdj.splice(0)) push('adjustments', a.row, { date, paidTo: a.paidTo, comment: a.comment });
    };

    for (let r = start + 1; r < end; r++) {
      const row = grid[r] || [];
      if (isTotal(row)) break;

      // Пометки пользователя в J/K: текст и числа, вписанные руками
      const words = [text(row[J]), text(row[K])].filter(Boolean);
      const below = grid[r + 1] || [];
      // «БУХ» и «данные» строкой ниже — одна пометка
      if (/бух/i.test(text(row[K])) && /данн/i.test(text(below[K])) && !num(below[C])) words.push(text(below[K]));
      const marks = [constNum(row[J]), constNum(row[K])].filter((x) => x != null).map((x) => `пометка: ${fmt(x)}`);

      const amount = num(row[C]), tariff = num(row[F]);
      if (amount > 0 && tariff > 0) {
        const date = dateAt(row[B], r);
        if (!date) { notes.push(`${meterName}, строка ${r + 1}: не понял дату «${row[B]?.v ?? ''}», строка пропущена`); continue; }
        flushAdj(date);
        if (maxDate && date < maxDate) {
          notes.push(`${meterName}, строка ${r + 1}: дата ${date.split('-').reverse().join('.')} раньше записи выше (${maxDate.split('-').reverse().join('.')}) — проверьте дату; в приложении записи идут по датам`);
        }
        const before = num(row[H]);
        const correction = before != null && (paidTo == null || Math.abs(before - paidTo) > 0.01);
        if (correction) {
          const comment = paidTo == null ? 'Начальное показание' : words.shift() || 'Корректировка из таблицы';
          push('adjustments', r, { date, paidTo: before, comment });
          if (paidTo != null) notes.push(`${meterName}, строка ${r + 1}: «счётчик до оплаты» ${fmt(before)} вместо ${fmt(paidTo)} → сверка`);
          paidTo = before;
        }
        const commission = num(row[D]) ?? 2;
        push('payments', r, { date, amount, commission, tariff, comment: [...words, ...marks].join('; ') });
        paidTo += (amount * (1 - commission / 100)) / tariff;
        lastDate = date;
        if (!maxDate || date > maxDate) maxDate = date;
      } else {
        // Строка без платежа: сверка, если указано «оплачено по»
        const value = num(row[I]) ?? num(row[H]);
        const label = text(row[B]) || words.join(' ');
        if (value != null && value > 0 && (label || num(row[H]) != null)) {
          // Строка без даты идёт после всего, что выше неё
          const date = dateAt(row[B], r) || maxDate;
          const adj = { row: r, paidTo: value, comment: label || 'Сверка' };
          if (date) push('adjustments', r, { date, paidTo: value, comment: adj.comment });
          else pendingAdj.push(adj);
          paidTo = value;
        }
      }

      // Взносы
      const dueAmount = parseNum(row[N]?.v);
      if (dueAmount > 0) {
        const date = dateAt(row[M], r);
        if (date) push('dues', r, { date, amount: dueAmount, comment: text(row[O]) });
        else notes.push(`${meterName}, строка ${r + 1}: не понял дату взноса «${row[M]?.v ?? ''}»`);
      }
    }
    if (pendingAdj.length) flushAdj(maxDate || today);
  });

  // История тарифов из оплат: каждая смена цены — тариф «для всех» с этой даты
  let lastPrice = null;
  const payments = records.filter((x) => x.kind === 'payments')
    .sort((a, b) => a.fields.date.localeCompare(b.fields.date));
  for (const p of payments) {
    if (p.fields.tariff === lastPrice) continue;
    lastPrice = p.fields.tariff;
    records.push({
      kind: 'tariffs', id: `legacy:tariff:${p.fields.date}`, meterName: '',
      fields: { from: p.fields.date, price: lastPrice }, order: records.length,
    });
  }
  return { records, notes };
}

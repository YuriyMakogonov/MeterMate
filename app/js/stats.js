// Расчёты: расход между показаниями, стоимость по тарифам, сводки.
//
// Правила:
// - расход интервала = текущее показание − предыдущее (с учётом перехода
//   счётчика через 99999.9 → 00000.0);
// - если тариф менялся внутри интервала, расход делится по дням и каждая
//   часть считается по своему тарифу;
// - интервал относится к месяцу, в котором снято закрывающее показание
//   (так же, как это обычно выглядит в квитанции).

export const dayNum = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 864e5;
};
export const fromDayNum = (n) => new Date(n * 864e5).toISOString().slice(0, 10);

const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** Цена кВт·ч на дату: последний действующий тариф; тариф счётчика важнее общего. */
export function priceOn(tariffs, meterId, day) {
  let best = null;
  for (const t of tariffs) {
    if (t.from > day || (t.meterId && t.meterId !== meterId)) continue;
    if (!best || t.from > best.from || (t.from === best.from && t.meterId && !best.meterId)) best = t;
  }
  return best ? best.price : null;
}

export function costOf(tariffs, meterId, from, to, kwh) {
  if (kwh < 0) return null;
  const d0 = dayNum(from), d1 = dayNum(to);
  if (d1 <= d0) {
    const p = priceOn(tariffs, meterId, to);
    return p == null ? null : kwh * p;
  }
  const perDay = kwh / (d1 - d0);
  let sum = 0;
  for (let d = d0 + 1; d <= d1; d++) {
    const p = priceOn(tariffs, meterId, fromDayNum(d));
    if (p == null) return null;
    sum += perDay * p;
  }
  return sum;
}

/** Интервалы между соседними показаниями одного счётчика. */
export function intervals(readings, tariffs, meter) {
  const max = 10 ** (meter.drums - meter.decimals);
  const out = [];
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1], b = readings[i];
    let kwh = b.value - a.value, rollover = false;
    if (kwh < 0 && a.value > max * 0.9 && b.value < max * 0.1) {
      kwh += max;
      rollover = true;
    }
    kwh = round(kwh);
    out.push({
      meterId: meter.id, prev: a, reading: b, kwh, rollover,
      days: dayNum(b.date) - dayNum(a.date),
      cost: costOf(tariffs, meter.id, a.date, b.date, kwh),
    });
  }
  return out;
}

/**
 * Сводка по периодам. keyOf(date) → ключ периода ('2026-10' или '2026').
 * Возвращает Map: ключ → { kwh, cost, missingCost, meters: { id: {kwh, cost, missingCost} } }
 */
export function aggregate(meters, readingsOf, tariffs, keyOf) {
  const out = new Map();
  for (const m of meters) {
    for (const iv of intervals(readingsOf(m.id), tariffs, m)) {
      if (iv.kwh < 0) continue;
      const key = keyOf(iv.reading.date);
      if (!out.has(key)) out.set(key, { kwh: 0, cost: 0, missingCost: false, meters: {} });
      const row = out.get(key);
      const mm = (row.meters[m.id] ||= { kwh: 0, cost: 0, missingCost: false });
      for (const target of [row, mm]) {
        target.kwh = round(target.kwh + iv.kwh);
        if (iv.cost == null) target.missingCost = true;
        else target.cost += iv.cost;
      }
    }
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export const byMonth = (date) => date.slice(0, 7);
export const byYear = (date) => date.slice(0, 4);

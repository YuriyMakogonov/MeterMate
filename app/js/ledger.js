// Учёт по оплатам (предоплата кВт), как в таблице пользователя:
//   дошло = сумма × (1 − комиссия/100)
//   кВт   = дошло / тариф
//   «счётчик до» = «оплачен по» предыдущей записи, «оплачен по» = до + кВт
// Сверка выставляет «оплачен по» на указанное значение.

import { byDate } from './store.js';
import { priceOn } from './stats.js';

export const netOf = (p) => p.amount * (1 - p.commission / 100);
export const kwhOf = (p) => (p.tariff > 0 ? netOf(p) / p.tariff : 0);

/**
 * Хронология оплат и сверок счётчика с расчётом «до/по».
 * @returns { rows: [{ kind, rec, from, to, net, kwh }], paidTo: number|null }
 */
export function ledger(payments, adjustments) {
  const events = [
    ...payments.map((rec) => ({ kind: 'payment', rec })),
    ...adjustments.map((rec) => ({ kind: 'adjustment', rec })),
  ].sort((a, b) => byDate(a.rec, b.rec));

  let paidTo = null;
  const rows = events.map((e) => {
    const from = paidTo ?? 0;
    if (e.kind === 'adjustment') {
      paidTo = e.rec.paidTo;
      return { ...e, from, to: paidTo, net: 0, kwh: 0 };
    }
    const net = netOf(e.rec), kwh = kwhOf(e.rec);
    paidTo = from + kwh;
    return { ...e, from, to: paidTo, net, kwh };
  });
  return { rows, paidTo };
}

/** «Красивая» сумма: округление вверх до 1 / 5 / 10. */
export function niceAmount(x) {
  if (!(x > 0)) return 0;
  const step = x < 20 ? 1 : x < 100 ? 5 : 10;
  return Math.ceil((x + 1e-9) / step) * step;
}

/** Сколько заплатить, чтобы на счёт дошли деньги за kwh по тарифу. */
export const amountFor = (kwh, tariff, commission) => (kwh * tariff) / (1 - commission / 100);

/**
 * Баланс счётчика: долг (debt > 0) или запас (debt < 0) в кВт относительно
 * последнего показания, и подсказка суммы для погашения.
 */
export function balance({ payments, adjustments, readings, tariffs, meterId, commission, today }) {
  const { paidTo } = ledger(payments, adjustments);
  const last = readings.at(-1) || null;
  const tariff = priceOn(tariffs, meterId, today);
  if (paidTo == null || !last) return { paidTo, last, tariff, debt: null };
  const debt = last.value - paidTo;
  const exact = debt > 0 && tariff ? amountFor(debt, tariff, commission) : 0;
  return { paidTo, last, tariff, debt, exact, suggested: niceAmount(exact) };
}

/** Итоги оплат и взносов по годам: Map год → { amount, commission, net, kwh, dues, count }. */
export function paymentYears(payments, dues) {
  const out = new Map();
  const row = (y) => {
    if (!out.has(y)) out.set(y, { amount: 0, commission: 0, net: 0, kwh: 0, dues: 0, count: 0 });
    return out.get(y);
  };
  for (const p of payments) {
    const r = row(p.date.slice(0, 4));
    const net = netOf(p);
    r.amount += p.amount;
    r.net += net;
    r.commission += p.amount - net;
    r.kwh += kwhOf(p);
    r.count++;
  }
  for (const d of dues) row(d.date.slice(0, 4)).dues += d.amount;
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

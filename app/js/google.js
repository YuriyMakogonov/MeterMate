// Синхронизация с Google Таблицей через Apps Script пользователя
// (код скрипта — google/Code.gs, установка — README).
//
// Отправка переписывает обе вкладки. Перед записью скрипт сверяет отпечаток
// вкладки «Данные» с тем, что было при прошлой синхронизации: если в таблице
// что-то поправили, запись отклоняется — сначала нужно загрузить изменения.

import * as store from './store.js';
import { buildWorkbookSheets } from './sheets.js';

const statusListeners = new Set();
export const onStatus = (fn) => statusListeners.add(fn);
const notify = () => statusListeners.forEach((fn) => fn(store.google()));

// Всегда POST: ключ уходит в теле запроса и не оседает в журналах адресов.
// Тело — строка (text/plain), поэтому браузер не делает предварительный запрос CORS.
async function request(body) {
  const { url, token } = store.google();
  if (!url) throw new Error('Не указан адрес скрипта Google');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
    throw new Error('Адрес скрипта должен иметь вид https://script.google.com/macros/s/…/exec');
  }
  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ token, ...body }) });
  if (!res.ok) throw new Error(`Google ответил ошибкой ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Скрипт ответил не данными. Проверьте адрес и доступ «Все» при развёртывании.');
  }
  if (data.error) throw new Error(data.error);
  return data;
}

/** Забрать обе вкладки: { main, data, hash } — двумерные массивы значений. */
export async function pull() {
  const res = await request({ action: 'read' });
  return { main: res.main || [], data: res.data || [], snapshot: res.snapshot || null, hash: res.hash };
}

/** Отправить текущие данные. force — перезаписать, даже если таблицу правили. */
export async function push({ force = false } = {}) {
  const [main, data, snapshot] = buildWorkbookSheets();
  const pack = (s) => ({ rows: s.rows, widths: s.widths });
  const res = await request({
    action: 'write', expectedHash: store.google().hash, force, main: pack(main), data: pack(data), snapshot: pack(snapshot),
  });
  if (res.conflict) {
    store.setGoogle({ pending: true, error: 'В Google Таблице изменили «Данные». Сначала загрузите изменения.' });
    notify();
    return { conflict: true };
  }
  store.setGoogle({ hash: res.hash, pending: false, error: '', at: new Date().toISOString() });
  store.markSynced();
  notify();
  return { ok: true };
}

/** Случайный ключ доступа: 32 символа из криптографического генератора. */
export function newToken() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint32Array(32)), (n) => abc[n % abc.length]).join('');
}

/** После загрузки из Google запоминаем отпечаток, чтобы следующая отправка прошла. */
export function rememberHash(hash) {
  store.setGoogle({ hash, error: '' });
}

// --- Автоотправка ---

let timer;

export function schedule() {
  const g = store.google();
  if (!g.url || !g.auto) return;
  store.setGoogle({ pending: true });
  notify();
  clearTimeout(timer);
  timer = setTimeout(flush, 2500);
}

export async function flush() {
  const g = store.google();
  if (!g.url || !g.auto || !g.pending || !navigator.onLine) return;
  try {
    await push();
  } catch (e) {
    store.setGoogle({ error: e.message });
    notify();
  }
}

window.addEventListener('online', flush);

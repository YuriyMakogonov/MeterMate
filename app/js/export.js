// Выгрузка в Excel (.xlsx) и резервная копия (.json).

import * as store from './store.js';
import { buildWorkbookSheets } from './sheets.js';
import { buildXlsx } from './xlsx.js';

/** Книга из двух вкладок: «Гаражи» (для людей) и «Данные» (для загрузки). */
export const workbook = () => buildXlsx(buildWorkbookSheets());

export const backup = () =>
  new Blob([JSON.stringify(store.snapshot(), null, 1)], { type: 'application/json' });

/**
 * @OnlyCurrentDoc
 *
 * MeterMate ↔ Google Таблица.
 *
 * Скрипт живёт в таблице пользователя и принимает от приложения POST-запросы:
 *   { action: 'read' }  — отдать вкладки «Гаражи», «Данные» и скрытый снимок «Гаражей»;
 *   { action: 'write' } — переписать вкладки (если «Данные» не правили с прошлой синхронизации).
 * Ключ доступа передаётся только в теле запроса, не в адресе.
 *
 * Установка — в README, раздел «Google Таблицы».
 * В свойствах скрипта нужно задать TOKEN — тот же ключ указывается в приложении.
 * @OnlyCurrentDoc выше ограничивает доступ скрипта этой таблицей.
 */

const MAIN = 'Гаражи';
const DATA = 'Данные';
const SNAPSHOT = '_Гаражи_снимок'; // скрытый снимок «Гаражей» для поиска ручных правок
const FORMATS = { date: 'dd.mm.yyyy', money: '#,##0.00', num: '#,##0.0##', tariff: '0.0000' };

function doGet() {
  return respond(() => {
    throw new Error('Скрипт работает только с приложением MeterMate');
  });
}

function doPost(e) {
  return respond(() => {
    const body = JSON.parse(e.postData.contents);
    checkToken(body.token);
    if (body.action === 'read') {
      return { main: readSheet(MAIN), data: readSheet(DATA), snapshot: readSheet(SNAPSHOT), hash: dataHash() };
    }
    if (body.action !== 'write') throw new Error('Неизвестное действие');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const current = dataHash();
      const hasData = getSheet(DATA).getLastRow() > 1;
      if (!body.force && hasData && body.expectedHash !== current) return { conflict: true, hash: current };
      writeSheet(MAIN, body.main, false);
      writeSheet(DATA, body.data, true);
      writeSheet(SNAPSHOT, body.snapshot, false);
      getSheet(SNAPSHOT).hideSheet();
      protectMain();
      SpreadsheetApp.flush();
      return { ok: true, hash: dataHash() };
    } finally {
      lock.releaseLock();
    }
  });
}

function respond(fn) {
  let out;
  try {
    out = fn();
  } catch (err) {
    out = { error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function checkToken(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!expected) throw new Error('В скрипте не задан TOKEN (Настройки проекта → Свойства скрипта)');
  if (token !== expected) throw new Error('Неверный ключ доступа');
}

function getSheet(name) {
  const ss = SpreadsheetApp.getActive();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function timeZone() {
  return SpreadsheetApp.getActive().getSpreadsheetTimeZone();
}

function readSheet(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh || sh.getLastRow() === 0) return [];
  const tz = timeZone();
  return sh.getDataRange().getValues().map((row) => row.map((v) => {
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    return v === '' ? null : v;
  }));
}

function dataHash() {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(readSheet(DATA)));
  return bytes.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

// Дата Excel (число дней) → дата в часовом поясе таблицы
function fromSerial(n) {
  const iso = Utilities.formatDate(new Date(Math.round(n - 25569) * 864e5), 'UTC', 'yyyy-MM-dd');
  return Utilities.parseDate(iso, timeZone(), 'yyyy-MM-dd');
}

function a1(row, col) {
  let s = '';
  for (let i = col + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s + (row + 1);
}

// Текст, начинающийся с = + - @, Google превратил бы в формулу (например,
// комментарий «=IMPORTXML(...)» мог бы отправить данные таблицы наружу).
// Апостроф в начале заставляет хранить его как текст; при чтении он не виден.
function safeValue(v) {
  if (v == null) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

function writeSheet(name, payload, freezeHeader) {
  const sh = getSheet(name);
  sh.clear();
  const rows = (payload && payload.rows) || [];
  if (!rows.length) return;
  const width = Math.max(1, ...rows.map((r) => r.length));
  const values = [];
  const byFormat = {};
  const bold = [];
  rows.forEach((row, r) => {
    const out = [];
    for (let c = 0; c < width; c++) {
      const raw = row[c];
      const cell = raw && typeof raw === 'object' ? raw : { v: raw };
      if (cell.f) out.push('=' + cell.f);
      else if (cell.style === 'date' && typeof cell.v === 'number') out.push(fromSerial(cell.v));
      else out.push(safeValue(cell.v));
      if (FORMATS[cell.style]) (byFormat[cell.style] = byFormat[cell.style] || []).push(a1(r, c));
      if (cell.style === 'bold') bold.push(a1(r, c));
    }
    values.push(out);
  });
  sh.getRange(1, 1, rows.length, width).setValues(values);
  Object.keys(byFormat).forEach((style) => sh.getRangeList(byFormat[style]).setNumberFormat(FORMATS[style]));
  if (bold.length) sh.getRangeList(bold).setFontWeight('bold');
  ((payload && payload.widths) || []).forEach((w, i) => sh.setColumnWidth(i + 1, Math.round(w * 7.5)));
  sh.setFrozenRows(freezeHeader ? 1 : 0);
}

// «Гаражи» — только для просмотра: при правке руками Google предупредит
function protectMain() {
  const sh = getSheet(MAIN);
  if (!sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
    sh.protect().setWarningOnly(true).setDescription('Только просмотр. Правьте вкладку «Данные» или приложение.');
  }
}

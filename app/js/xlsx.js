// Минимальный генератор .xlsx без зависимостей: XML-листы, упакованные
// в zip без сжатия. Открывается в Excel, Google Таблицах и Numbers.
//
// Ячейка: число, строка, null или { v, style: 'bold' | 'money' }.

const enc = new TextEncoder();

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // имена в UTF-8
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(local, nameBytes, data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dirSize = central.reduce((n, c) => n + c.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

function colName(i) {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

// Стили ячеек: bold — заголовок, money — сумма, num — кВт, date — дата
// (значение — серийный номер дня Excel), tariff — цена с 4 знаками.
const STYLE = { bold: 1, money: 2, num: 3, date: 4, tariff: 5 };

function cellXml(cell, ref) {
  const { v, style, f } = typeof cell === 'object' ? cell : { v: cell };
  if ((v == null || v === '') && !f) return '';
  const s = STYLE[style] ? ` s="${STYLE[style]}"` : '';
  if (f) {
    // Формула плюс посчитанное значение, чтобы файл читался и без пересчёта
    const cached = v == null ? '' : typeof v === 'number' ? `<v>${v}</v>` : `<v>${esc(v)}</v>`;
    const t = typeof v === 'string' ? ' t="str"' : '';
    return `<c r="${ref}"${s}${t}><f>${esc(f)}</f>${cached}</c>`;
  }
  return typeof v === 'number'
    ? `<c r="${ref}"${s}><v>${v}</v></c>`
    : `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

function sheetXml({ rows, widths, freeze = true }) {
  const body = rows.map((row, r) => {
    const cells = (row || []).map((cell, c) => (cell == null || cell === '' ? '' : cellXml(cell, colName(c) + (r + 1)))).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const cols = widths?.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const pane = freeze ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>${cols}<sheetData>${body}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.0##"/><numFmt numFmtId="165" formatCode="dd.mm.yyyy"/><numFmt numFmtId="166" formatCode="0.0000"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

/** sheets: [{ name, rows: [[cell, ...], ...], widths?: [number], freeze?: bool, hidden?: bool }] → Blob */
export function buildXlsx(sheets) {
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name.slice(0, 31))}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zip(files.map(([name, text]) => ({ name, data: enc.encode(text) })));
}

// --- Чтение .xlsx ---

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Файл не похож на .xlsx');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const files = {};
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Повреждённый .xlsx');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) files[name] = data;
    else if (method === 8) files[name] = await inflateRaw(data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const xml = (bytes) => new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
const tags = (node, name) => [...node.getElementsByTagNameNS('*', name)];
const textOf = (node) => tags(node, 't').map((t) => t.textContent).join('');

function colIndex(ref) {
  let n = 0;
  for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

/**
 * Прочитать книгу. Возвращает { names, sheet(name) } где sheet → двумерный
 * массив ячеек { v, f } (v — число или строка; даты остаются числами Excel).
 */
export async function readXlsx(buffer) {
  const files = await unzip(buffer);
  const need = (name) => {
    if (!files[name]) throw new Error('Файл не похож на .xlsx');
    return files[name];
  };
  const strings = files['xl/sharedStrings.xml'] ? tags(xml(files['xl/sharedStrings.xml']), 'si').map(textOf) : [];
  const rels = Object.fromEntries(tags(xml(need('xl/_rels/workbook.xml.rels')), 'Relationship')
    .map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));
  const sheets = tags(xml(need('xl/workbook.xml')), 'sheet').map((s) => {
    const rid = s.getAttribute('r:id') || [...s.attributes].find((a) => a.localName === 'id')?.value;
    const target = rels[rid].replace(/^\//, '');
    return { name: s.getAttribute('name'), path: target.startsWith('xl/') ? target : `xl/${target}` };
  });

  const parse = (path) => {
    const grid = [];
    for (const c of tags(xml(need(path)), 'c')) {
      const ref = c.getAttribute('r');
      const row = +ref.match(/\d+$/)[0] - 1, col = colIndex(ref);
      const t = c.getAttribute('t');
      const vNode = tags(c, 'v')[0], fNode = tags(c, 'f')[0];
      let v = vNode ? vNode.textContent : null;
      if (t === 's' && v != null) v = strings[+v];
      else if (t === 'inlineStr') v = textOf(c);
      else if (t === 'b') v = v === '1';
      else if (t !== 'str' && t !== 'e' && v != null && v !== '') v = Number(v);
      if (v == null && !fNode) continue;
      (grid[row] ||= [])[col] = { v, f: fNode ? fNode.textContent || 'shared' : null };
    }
    return Array.from(grid, (r) => r || []);
  };

  return { names: sheets.map((s) => s.name), sheet: (name) => {
    const s = sheets.find((x) => x.name === name);
    return s ? parse(s.path) : null;
  } };
}

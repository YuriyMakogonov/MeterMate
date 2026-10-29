// Распознавание цифр на барабанах без нейросетей: полоса режется на равные
// ячейки, каждая сравнивается с эталонами цифр нормированной корреляцией
// (NCC) с небольшим перебором сдвигов. Эталоны — нарисованные шрифтом
// цифры плюс образцы, сохранённые из подтверждённых показаний этого счётчика.

export const TW = 24, TH = 36; // размер эталона
const CW = 30, CH = 48;        // размер ячейки (с запасом под сдвиг: барабаны бывают провёрнуты)

const gray = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

function normalize(arr) {
  let mean = 0;
  for (const v of arr) mean += v;
  mean /= arr.length;
  const out = new Float32Array(arr.length);
  let norm = 0;
  for (let i = 0; i < arr.length; i++) {
    out[i] = arr[i] - mean;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-6) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function canvas(w, hgt) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  return c;
}

// --- Эталоны, нарисованные шрифтом: стартовая точка до обучения ---

let synthetic;

function renderDigit(ch, font) {
  const big = canvas(120, 140);
  const ctx = big.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 120, 140);
  ctx.fillStyle = '#fff';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.fillText(ch, 60, 115);
  const d = ctx.getImageData(0, 0, 120, 140).data;
  let x0 = 120, x1 = 0, y0 = 140, y1 = 0;
  for (let y = 0; y < 140; y++) for (let x = 0; x < 120; x++) {
    if (d[(y * 120 + x) * 4] > 128) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  const t = canvas(TW, TH);
  const tc = t.getContext('2d', { willReadFrequently: true });
  tc.fillStyle = '#000';
  tc.fillRect(0, 0, TW, TH);
  const th = TH * 0.78, scale = th / (y1 - y0 + 1);
  const tw = Math.min(TW * 0.8, (x1 - x0 + 1) * scale * 0.85);
  tc.drawImage(big, x0, y0, x1 - x0 + 1, y1 - y0 + 1, (TW - tw) / 2, (TH - th) / 2, tw, th);
  const td = tc.getImageData(0, 0, TW, TH).data;
  return Float32Array.from({ length: TW * TH }, (_, i) => gray(td, i * 4));
}

function syntheticTemplates() {
  if (synthetic) return synthetic;
  const fonts = [
    'bold 100px Arial, Helvetica, sans-serif',
    '100px Arial, Helvetica, sans-serif',
    'bold 100px "DIN Condensed", "Arial Narrow", sans-serif-condensed, sans-serif',
  ];
  synthetic = [];
  for (const font of fonts) {
    for (let d = 0; d < 10; d++) synthetic.push({ digit: d, vec: normalize(renderDigit(String(d), font)) });
  }
  return synthetic;
}

// --- Обученные образцы хранятся как base64 от Uint8 TW×TH ---

const encode = (arr) => btoa(String.fromCharCode(...Uint8Array.from(arr, (v) => Math.round(v))));
const decode = (b64) => Float32Array.from(atob(b64), (c) => c.charCodeAt(0));

function learnedTemplates(samples) {
  const out = [];
  for (const [digit, list] of Object.entries(samples || {})) {
    for (const b64 of list) out.push({ digit: +digit, vec: normalize(decode(b64)), learned: true });
  }
  return out;
}

// --- Подготовка ячеек ---

// Масштабы ячейки относительно эталона: цифра в рамке может быть крупнее
// или мельче (рамка нарисована свободно), поэтому полосу смотрим в
// нескольких увеличениях и выбираем лучшее совпадение.
const SCALES = [0.8, 1, 1.25, 1.55];

function grayCells(strip, drums, f) {
  const cw = Math.round(CW * f), ch = Math.round(CH * f);
  const c = canvas(drums * cw, ch);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(strip, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  return Array.from({ length: drums }, (_, k) => {
    const g = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) g[y * cw + x] = gray(d, (y * c.width + k * cw + x) * 4);
    return { g, cw, ch };
  });
}

// Цифра занимает меньшую часть ячейки. Если «хвост» распределения тёмный
// (чёрная цифра на белом барабане) — цифру надо инвертировать, чтобы она
// была светлой, как в эталонах.
function darkDigit(g) {
  const sorted = Float32Array.from(g).sort();
  const median = sorted[sorted.length >> 1];
  const mean = g.reduce((a, b) => a + b, 0) / g.length;
  return mean < median;
}

function prepareCells(strip, drums) {
  const byScale = SCALES.map((f) => grayCells(strip, drums, f));
  const sw = strip.width / drums;
  return Array.from({ length: drums }, (_, k) => {
    const invert = darkDigit(byScale[1][k].g);
    const patches = [];
    byScale.forEach((cells, si) => {
      const { g, cw, ch } = cells[k];
      if (invert) for (let i = 0; i < g.length; i++) g[i] = 255 - g[i];
      const step = SCALES[si] > 1.2 ? 2 : 1;
      for (let oy = 0; oy <= ch - TH; oy += step) for (let ox = 0; ox <= cw - TW; ox += step) {
        const raw = new Float32Array(TW * TH);
        for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) raw[y * TW + x] = g[(y + oy) * cw + x + ox];
        patches.push({ raw, vec: normalize(raw) });
      }
    });
    const preview = canvas(60, Math.round((60 * strip.height) / sw) || 80);
    preview.getContext('2d').drawImage(strip, k * sw, 0, sw, strip.height, 0, 0, preview.width, preview.height);
    return { patches, preview };
  });
}

/**
 * Распознать полосу барабанов.
 * @returns массив по ячейкам: { digit, score, margin, confident, preview, best }
 */
export function recognize(strip, drums, samples) {
  const templates = [...syntheticTemplates(), ...learnedTemplates(samples)];
  return prepareCells(strip, drums).map((cell) => {
    const best = Array.from({ length: 10 }, () => ({ score: -1, patch: null }));
    for (const p of cell.patches) {
      for (const t of templates) {
        const s = dot(p.vec, t.vec);
        if (s > best[t.digit].score) best[t.digit] = { score: s, patch: p };
      }
    }
    const order = [...best.keys()].sort((a, b) => best[b].score - best[a].score);
    const score = best[order[0]].score;
    const margin = score - best[order[1]].score;
    return {
      digit: order[0], alt: order[1], score, margin,
      confident: score > 0.55 && margin > 0.08,
      preview: cell.preview, best,
    };
  });
}

/**
 * Образцы для обучения из подтверждённых пользователем цифр.
 * Ячейки, явно не похожие на свою цифру (барабан «между» цифрами),
 * пропускаются, чтобы не портить эталоны.
 */
export function samplesFrom(results, digits, existing) {
  const own = learnedTemplates(existing);
  const out = {};
  results.forEach((r, i) => {
    const d = digits[i];
    if (d == null) return;
    const { score, patch } = r.best[d];
    if (!patch || score < 0.3) return;
    const same = own.filter((t) => t.digit === d);
    if (same.length && Math.max(...same.map((t) => dot(t.vec, patch.vec))) < 0.5) return;
    (out[d] ||= []).push(encode(patch.raw));
  });
  return out;
}

// Распознавание цифр на барабанах без нейросетей.
//
// Для полосы барабанов в рамке:
//   1. Находим барабаны. Светлые барабаны с тёмной цифрой (СО-И446) ищутся
//      по всей полосе как светлые прямоугольники в тёмном окне. Если их не
//      нашлось — рамка делится поровну, это тёмные барабаны со светлой
//      цифрой (СО-197) или снимок, где барабаны не выделяются.
//   2. Яркость приводится к виду «цифра светлая, фон тёмный».
//   3. Цифра — связные пятна в середине барабана; её рамка растягивается до
//      стандартного размера, так что неважно, насколько крупно снято фото и
//      насколько точно поставлена рамка.
//   4. Нормированная цифра сравнивается с эталонами (корреляция NCC с
//      небольшим сдвигом). Эталоны — цифры, нарисованные шрифтами, и образцы,
//      сохранённые из подтверждённых показаний этого счётчика.

export const TW = 20, TH = 32; // размер нормированной цифры
const PAD = 2;                 // запас под сдвиг при сравнении
const CELL_H = 72;             // высота ячейки при анализе

// --- Мелкие помощники ---

const gray = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

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

/** Порог Оцу для значений 0..255. */
function otsu(values) {
  const hist = new Float64Array(256);
  for (const v of values) hist[Math.max(0, Math.min(255, v | 0))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/** Связные области маски (4-связность): [{ count, x0, y0, x1, y1 }], у массива — .label */
function components(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const out = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = out.length;
    const c = { count: 0, x0: w, y0: h, x1: 0, y1: 0 };
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p - x) / w;
      c.count++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h || label[q] >= 0 || !mask[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
        label[q] = id;
        stack.push(q);
      }
    }
    out.push(c);
  }
  out.label = label;
  return out;
}

/** Билинейная выборка прямоугольника src в прямоугольник dst. */
function resample(src, sw, sh, box, dst, dw, dh, target) {
  for (let y = 0; y < target.h; y++) {
    for (let x = 0; x < target.w; x++) {
      const fx = box.x0 + ((x + 0.5) / target.w) * (box.x1 - box.x0 + 1) - 0.5;
      const fy = box.y0 + ((y + 0.5) / target.h) * (box.y1 - box.y0 + 1) - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
      const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
      const v = (src[y0 * sw + x0] * (1 - ax) + src[y0 * sw + x1] * ax) * (1 - ay)
        + (src[y1 * sw + x0] * (1 - ax) + src[y1 * sw + x1] * ax) * ay;
      const tx = target.x + x, ty = target.y + y;
      if (tx >= 0 && ty >= 0 && tx < dw && ty < dh) dst[ty * dw + tx] = v;
    }
  }
}

function blur(src, w, h) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      s += src[yy * w + xx];
      n++;
    }
    out[y * w + x] = s / n;
  }
  return out;
}

/**
 * Нормировать цифру: g — яркость (цифра светлая), рамка цифры box.
 * Возвращает поле (TW+2·PAD)×(TH+2·PAD) с цифрой по центру.
 */
function place(g, w, h, box, bg) {
  const W = TW + 2 * PAD, H = TH + 2 * PAD;
  const out = new Float32Array(W * H).fill(bg);
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  const th = Math.round(TH * 0.92);
  // Только совсем узкие знаки («1») сохраняют пропорцию, остальные
  // растягиваются до общей ширины: у счётчиков цифры узкие, у шрифтов —
  // широкие, и так их можно сравнивать.
  const tw = bw / bh < 0.26 ? Math.max(3, Math.round((bw / bh) * th)) : Math.round(TW * 0.8);
  resample(g, w, h, box, out, W, H, { x: Math.round((W - tw) / 2), y: Math.round((H - th) / 2), w: tw, h: th });
  return blur(out, W, H);
}

/**
 * Найти цифру внутри области барабана.
 * g — яркость полосы (ширина W), region — барабан, lightDrum — цифра тёмная.
 * Возвращает { field, found, box } — нормированное поле с цифрой.
 */
function digitIn(g, W, region, lightDrum) {
  const rw = region.x1 - region.x0 + 1, rh = region.y1 - region.y0 + 1;
  const sub = new Float32Array(Math.max(1, rw * rh));
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const v = g[(y + region.y0) * W + x + region.x0];
    sub[y * rw + x] = lightDrum ? 255 - v : v; // цифра — светлая
  }
  const all = { x0: 0, y0: 0, x1: rw - 1, y1: rh - 1 };
  if (rw < 4 || rh < 6) return { field: place(sub, rw, rh, all, 0), found: false };

  const t = otsu(sub);
  const mask = Uint8Array.from(sub, (v) => v > t);
  // Тени и края барабана — полосы, закрашенные почти целиком по всей
  // длине. Срезаем такие крайние столбцы и строки (не больше четверти).
  const colFill = (x) => { let n = 0; for (let y = 0; y < rh; y++) n += mask[y * rw + x]; return n / rh; };
  const rowFill = (y) => { let n = 0; for (let x = 0; x < rw; x++) n += mask[y * rw + x]; return n / rw; };
  let cx0 = 0, cx1 = rw - 1, cy0 = 0, cy1 = rh - 1;
  while (cx0 < rw * 0.25 && colFill(cx0) > 0.8) cx0++;
  while (cx1 > rw * 0.75 && colFill(cx1) > 0.8) cx1--;
  while (cy0 < rh * 0.25 && rowFill(cy0) > 0.8) cy0++;
  while (cy1 > rh * 0.75 && rowFill(cy1) > 0.8) cy1--;
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    if (x < cx0 || x > cx1 || y < cy0 || y > cy1) mask[y * rw + x] = 0;
  }
  const comps = components(mask, rw, rh).filter((c) => c.count >= rw * rh * 0.015);
  let bg = 0, nbg = 0;
  for (let i = 0; i < sub.length; i++) if (!mask[i]) { bg += sub[i]; nbg++; }
  bg = nbg ? bg / nbg : 0;

  // Пятна цифры: в средней части по ширине, заметной высоты, не полосы во всю ширину
  const central = comps.filter((c) => c.x1 >= rw * 0.2 && c.x0 <= rw * 0.8
    && c.y1 - c.y0 + 1 >= rh * 0.15 && c.x1 - c.x0 + 1 < rw * 0.92);
  if (!central.length) return { field: place(sub, rw, rh, all, bg), found: false };

  // Главное пятно и те, что лежат с ним на одной высоте (разорванная «4»),
  // без кусков соседних цифр сверху/снизу при провёрнутом барабане
  const main = central.sort((a, b) => b.count - a.count)[0];
  const box = { ...main };
  for (const c of central) {
    if (c === main) continue;
    const overlap = Math.min(c.y1, main.y1) - Math.max(c.y0, main.y0) + 1;
    if (overlap > 0.5 * Math.min(c.y1 - c.y0 + 1, main.y1 - main.y0 + 1)) {
      box.x0 = Math.min(box.x0, c.x0); box.y0 = Math.min(box.y0, c.y0);
      box.x1 = Math.max(box.x1, c.x1); box.y1 = Math.max(box.y1, c.y1);
    }
  }
  return { field: place(sub, rw, rh, box, bg), found: true, box };
}

/** Внутренняя часть барабана без тёмных краёв и теней. */
const inner = (f) => {
  const dx = Math.round((f.x1 - f.x0 + 1) * 0.12), dy = Math.round((f.y1 - f.y0 + 1) * 0.05);
  return { x0: f.x0 + dx, y0: f.y0 + dy, x1: f.x1 - dx, y1: f.y1 - dy };
};

/** Морфология по прямоугольнику (kx×ky): max — расширение, min — сужение. */
function morph(mask, W, H, kx, ky, op) {
  const pass = (src, horizontal) => {
    const out = new Uint8Array(W * H);
    const k = horizontal ? kx : ky;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = op === 'max' ? 0 : 1;
      for (let d = -k; d <= k; d++) {
        const xx = horizontal ? x + d : x, yy = horizontal ? y : y + d;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const m = src[yy * W + xx];
        if (op === 'max' && m) { v = 1; break; }
        if (op === 'min' && !m) { v = 0; break; }
      }
      out[y * W + x] = v;
    }
    return out;
  };
  return pass(pass(mask, true), false);
}

/**
 * Светлые барабаны (СО-И446) — светлые прямоугольники в тёмном окне. Ищем их
 * на всей полосе: пиксель «светлый», если он ярче своей окрестности
 * (адаптивный порог), барабан — связная светлая область, которую светлые
 * поля сверху и снизу цифры держат целой. Белая панель вокруг окна,
 * попавшая в рамку у краёв, отрезается. Барабаны стоят в окне неравномерно,
 * поэтому так точнее, чем делить рамку поровну. Возвращает null, если
 * барабанов не нашлось ровно столько, сколько ожидалось.
 */
function findFaces(g, W, H, drums) {
  const cellW = W / drums;
  const colMed = new Float32Array(W);
  const col = new Float32Array(H);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) col[y] = g[y * W + x];
    col.sort();
    colMed[x] = col[H >> 1];
  }
  // Средняя яркость окрестности (примерно ячейка в ширину и полполосы в
  // высоту) через интегральное изображение. Окрестность двумерная, чтобы
  // светлая полоса панели сверху или снизу влияла только на свои строки.
  const rx = Math.max(2, Math.round(cellW * 0.6)), ry = Math.max(2, Math.round(H * 0.3));
  const sat = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += g[y * W + x];
      sat[(y + 1) * (W + 1) + x + 1] = sat[y * (W + 1) + x + 1] + row;
    }
  }
  const local = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const x0 = Math.max(0, x - rx), x1 = Math.min(W, x + rx + 1), y0 = Math.max(0, y - ry), y1 = Math.min(H, y + ry + 1);
    const sum = sat[y1 * (W + 1) + x1] - sat[y0 * (W + 1) + x1] - sat[y1 * (W + 1) + x0] + sat[y0 * (W + 1) + x0];
    local[y * W + x] = sum / ((x1 - x0) * (y1 - y0));
  }

  // Панель у краёв ярче любого барабана внутри окна
  const edge = Math.round(W * 0.06);
  const paper = Math.max(...colMed.slice(edge, W - edge)) + 8;
  let lo = 0, hi = W - 1;
  while (lo < W && colMed[lo] > paper) lo++;
  while (hi >= 0 && colMed[hi] > paper) hi--;

  let mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = lo; x <= hi; x++) mask[y * W + x] = g[y * W + x] > local[y * W + x] + 6;
  mask = morph(morph(mask, W, H, 1, 1, 'min'), W, H, 1, 1, 'max'); // убрать мелкий шум

  const comps = components(mask, W, H).filter((c) => {
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
    return ch >= H * 0.4 && cw >= cellW * 0.15 && cw <= cellW;
  });
  // Барабан светлый в основном (цифра — меньшая часть). У тёмных барабанов
  // со светлыми цифрами (СО-197) светлая область — это сама цифра.
  const cands = comps.filter((c) => {
    const vals = [];
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) vals.push(g[y * W + x] - local[y * W + x]);
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1] > 4;
  }).sort((a, b) => a.x0 - b.x0);
  return pickEvenlySpaced(cands, drums, W, H, cellW);
}

const mid = (f) => (f.x0 + f.x1) / 2;

/**
 * Барабаны в счётчике стоят с одинаковым шагом. Из кандидатов выбираем
 * набор, центры которого лучше всего ложатся на равный шаг (лишнее —
 * блики и края окна). Если крайний барабан срезан рамкой и не нашёлся,
 * его место достраивается по шагу.
 */
function pickEvenlySpaced(cands, drums, W, H, cellW) {
  // Отклонение центров от равного шага (метод наименьших квадратов)
  const fit = (set) => {
    const n = set.length, xs = set.map(mid);
    const mi = (n - 1) / 2, mx = xs.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    xs.forEach((x, i) => { num += (i - mi) * (x - mx); den += (i - mi) ** 2; });
    const pitch = den ? num / den : cellW;
    const worst = Math.max(...xs.map((x, i) => Math.abs(x - (mx + (i - mi) * pitch))));
    return { pitch, start: mx - mi * pitch, worst };
  };
  const good = (f) => f.pitch > cellW * 0.5 && f.pitch < cellW * 1.4 && f.worst < cellW * 0.22;

  // Все наборы нужного размера (кандидатов обычно немного)
  const choose = (k, from = 0, acc = [], out = []) => {
    if (acc.length === k) { out.push(acc); return out; }
    for (let i = from; i <= cands.length - (k - acc.length); i++) choose(k, i + 1, [...acc, cands[i]], out);
    return out;
  };
  const best = (k) => (cands.length >= k && cands.length <= 12 ? choose(k) : [])
    .map((set) => ({ set, f: fit(set) }))
    .filter((x) => good(x.f))
    .sort((a, b) => a.f.worst - b.f.worst)[0];

  const full = best(drums);
  if (full) return full.set.map((f) => ({ x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 }));

  // Одного крайнего не хватает: достроить по шагу
  const part = drums >= 3 ? best(drums - 1) : null;
  if (!part) return null;
  const { pitch, start } = part.f;
  const set = part.set;
  const width = set.reduce((a, f) => a + f.x1 - f.x0 + 1, 0) / set.length;
  const y0 = Math.round(set.reduce((a, f) => a + f.y0, 0) / set.length);
  const y1 = Math.round(set.reduce((a, f) => a + f.y1, 0) / set.length);
  const make = (c) => ({
    x0: Math.max(0, Math.round(c - width / 2)), y0, x1: Math.min(W - 1, Math.round(c + width / 2)), y1,
  });
  const before = start - pitch, after = start + (drums - 1) * pitch;
  const faces = set.map((f) => ({ x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 }));
  // Достраиваем с той стороны, где барабан помещается в рамку лучше
  const roomBefore = before + width / 2, roomAfter = W - (after - width / 2);
  if (roomBefore >= roomAfter && roomBefore > width * 0.4) return [make(before), ...faces];
  if (roomAfter > width * 0.4) return [...faces, make(after)];
  return null;
}

/**
 * Области барабанов на полосе: для каждого барабана — варианты
 * [{ region, lightDrum, face }]. Если светлые барабаны найдены — вариант один.
 * Иначе рамка делится поровну и для каждой части пробуются обе полярности:
 * светлая цифра на тёмном барабане (СО-197) и тёмная на светлом. Какая
 * верна, решает сравнение с эталонами.
 */
function drumRegions(g, W, H, drums) {
  const faces = findFaces(g, W, H, drums);
  if (faces) return faces.map((f) => [{ region: inner(f), lightDrum: true, face: f }]);

  const cellW = W / drums;
  return Array.from({ length: drums }, (_, k) => {
    const cell = { x0: Math.round(k * cellW), y0: 0, x1: Math.round((k + 1) * cellW) - 1, y1: H - 1 };
    const dark = { region: cell, lightDrum: false, face: cell };
    // Светлый барабан внутри части — светлая область, занимающая её середину
    const w = cell.x1 - cell.x0 + 1;
    const vals = [];
    for (let y = 0; y < H; y++) for (let x = cell.x0; x <= cell.x1; x++) vals.push(g[y * W + x]);
    const t = otsu(vals);
    const mask = new Uint8Array(w * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < w; x++) mask[y * w + x] = g[y * W + cell.x0 + x] > t;
    const comps = components(mask, w, H);
    const votes = new Map();
    for (let y = Math.round(H * 0.2); y < H * 0.8; y++) {
      for (let x = Math.round(w * 0.3); x < w * 0.7; x++) {
        const id = comps.label[y * w + x];
        if (id >= 0) votes.set(id, (votes.get(id) || 0) + 1);
      }
    }
    const f = comps[[...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]];
    const face = f && f.y1 - f.y0 >= H * 0.3 ? { x0: f.x0 + cell.x0, y0: f.y0, x1: f.x1 + cell.x0, y1: f.y1 } : cell;
    return [dark, { region: face === cell ? cell : inner(face), lightDrum: true, face }];
  });
}

/** Вырезать из поля окно TW×TH со сдвигом (ox, oy). */
function shifted(field, ox, oy) {
  const W = TW + 2 * PAD;
  const out = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) out[y * TW + x] = field[(y + oy) * W + x + ox];
  return out;
}

const center = (field) => shifted(field, PAD, PAD);

// --- Эталоны, нарисованные шрифтами: стартовая точка до обучения ---

let synthetic;

function renderDigit(ch, font) {
  const S = 140;
  const c = canvas(S, S);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = '#fff';
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(ch, S / 2, S / 2);
  const d = ctx.getImageData(0, 0, S, S).data;
  const g = Float32Array.from({ length: S * S }, (_, i) => gray(d, i * 4));
  const box = { x0: S, y0: S, x1: 0, y1: 0 };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (g[y * S + x] > 128) {
      box.x0 = Math.min(box.x0, x); box.x1 = Math.max(box.x1, x);
      box.y0 = Math.min(box.y0, y); box.y1 = Math.max(box.y1, y);
    }
  }
  return center(place(g, S, S, box, 0));
}

function syntheticTemplates() {
  if (synthetic) return synthetic;
  const fonts = [
    'bold 100px Arial, Helvetica, sans-serif',
    '100px Arial, Helvetica, sans-serif',
    'bold 100px "Arial Narrow", "Roboto Condensed", "Helvetica Neue", sans-serif',
    '100px "DejaVu Sans Condensed", "Roboto Condensed", "Arial Narrow", sans-serif',
    'bold 100px "Courier New", monospace',
  ];
  synthetic = [];
  for (const font of fonts) {
    for (let d = 0; d < 10; d++) synthetic.push({ digit: d, vec: normalize(renderDigit(String(d), font)) });
  }
  return synthetic;
}

// --- Обученные образцы: base64 от Uint8 TW×TH ---

const encode = (arr) => {
  let min = Infinity, max = -Infinity;
  for (const v of arr) { if (v < min) min = v; if (v > max) max = v; }
  const k = max > min ? 255 / (max - min) : 0;
  return btoa(String.fromCharCode(...Uint8Array.from(arr, (v) => Math.round((v - min) * k))));
};
const decode = (b64) => Float32Array.from(atob(b64), (c) => c.charCodeAt(0));

function learnedTemplates(samples) {
  const out = [];
  for (const [digit, list] of Object.entries(samples || {})) {
    for (const b64 of list) {
      const v = decode(b64);
      if (v.length === TW * TH) out.push({ digit: +digit, vec: normalize(v), learned: true });
    }
  }
  return out;
}

// --- Полоса и барабаны ---

/** Яркость полосы, приведённая к высоте CELL_H. */
function stripGray(strip) {
  const H = CELL_H, W = Math.max(8, Math.round((H * strip.width) / strip.height));
  const c = canvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(strip, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  return { g: Float32Array.from({ length: W * H }, (_, i) => gray(d, i * 4)), W, H };
}

/** Для отладки и тестов: что алгоритм видит в каждом барабане. */
export function inspect(strip, drums) {
  const { g, W, H } = stripGray(strip);
  return drumRegions(g, W, H, drums).map((vs) => vs.map((r) => ({ ...r, ...digitIn(g, W, r.region, r.lightDrum) })));
}

function prepareCells(strip, drums) {
  const { g, W, H } = stripGray(strip);
  const k = strip.height / H; // из координат анализа в пиксели полосы
  return drumRegions(g, W, H, drums).map((variants) => {
    const shifts = [];
    let found = false;
    for (const { region, lightDrum } of variants) {
      const d = digitIn(g, W, region, lightDrum);
      found ||= d.found;
      for (let oy = 0; oy <= 2 * PAD; oy++) for (let ox = 0; ox <= 2 * PAD; ox++) {
        const raw = shifted(d.field, ox, oy);
        shifts.push({ raw, vec: normalize(raw) });
      }
    }
    const { face } = variants.at(-1);
    const split = variants.length > 1; // барабаны не найдены, рамка поделена поровну
    // Превью — найденный барабан, а не равная доля рамки
    const fw = (face.x1 - face.x0 + 1) * k, fh = (face.y1 - face.y0 + 1) * k;
    const preview = canvas(60, Math.round((60 * fh) / fw) || 80);
    preview.getContext('2d').drawImage(strip, face.x0 * k, face.y0 * k, fw, fh, 0, 0, preview.width, preview.height);
    return { shifts, found, split, preview };
  });
}

/**
 * Распознать полосу барабанов.
 * @returns массив по ячейкам: { digit, alt, score, margin, confident, preview, best }
 */
export function recognize(strip, drums, samples) {
  const learned = learnedTemplates(samples);
  const templates = [...syntheticTemplates(), ...learned];
  return prepareCells(strip, drums).map((cell) => {
    const best = Array.from({ length: 10 }, () => ({ score: -1, patch: null }));
    for (const p of cell.shifts) {
      for (const t of templates) {
        const s = dot(p.vec, t.vec);
        if (s > best[t.digit].score) best[t.digit] = { score: s, patch: p };
      }
    }
    const order = [...best.keys()].sort((a, b) => best[b].score - best[a].score);
    const score = best[order[0]].score;
    const margin = score - best[order[1]].score;
    // С выученными образцами совпадение заметно выше, поэтому порог строже.
    // Если барабаны не нашлись и пробовались обе полярности, ложные
    // совпадения вероятнее — тоже строже.
    const [minScore, minMargin] = learned.length ? [0.8, 0.06] : cell.split ? [0.82, 0.12] : [0.7, 0.08];
    const confident = cell.found && score > minScore && margin > minMargin;
    return { digit: order[0], alt: order[1], score, margin, confident, preview: cell.preview, best };
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
    if (!patch || score < 0.35) return;
    const same = own.filter((t) => t.digit === d);
    if (same.length && Math.max(...same.map((t) => dot(t.vec, patch.vec))) < 0.6) return;
    (out[d] ||= []).push(encode(patch.raw));
  });
  return out;
}

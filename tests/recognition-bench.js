// Стенд для замера распознавания. Фото лежат в .local-test/ (в git не попадают):
// garage1.jpg, garage2.jpg — счётчики СО-И446, meter.webp — СО-197.
// Запуск в консоли страницы приложения (сервер из корня репозитория):
//   const B = await import("/tests/recognition-bench.js");
//   const R = await import("/app/js/recognizer.js");
//   await B.run(R.recognize);                                                   // без обучения
//   await B.run(R.recognize, { learnFrom: { index: 1 }, samplesFrom: R.samplesFrom }); // после одного подтверждения
// Каждое фото режется с «человеческими» сдвигами, масштабом и наклоном рамки.
import { Cropper } from '/app/js/cropper.js';

export const SAMPLES = [
  { file: '/.local-test/garage1.jpg', rect: { x: 452, y: 1052, w: 263, h: 115 }, angle: -3.5, drums: 4, digits: [4, 9, 0, 2] },
  { file: '/.local-test/garage2.jpg', rect: { x: 453, y: 933, w: 234, h: 94 }, angle: 0, drums: 4, digits: [5, 7, 0, 0] },
  { file: '/.local-test/meter.webp', rect: { x: 390, y: 334, w: 212, h: 44 }, angle: 10.8, drums: 6, digits: [0, 0, 0, 1, 9, 9], rotatedRect: true },
];

async function load(url) {
  const blob = await (await fetch(url)).blob();
  const img = await createImageBitmap(blob); // работает и в фоновой вкладке
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

const JITTER = [{ dx: 0, dy: 0, s: 1, da: 0 }];
for (const dx of [-0.03, 0.03]) for (const dy of [-0.08, 0.08]) for (const s of [0.94, 1.06]) for (const da of [-2, 2]) {
  JITTER.push({ dx, dy, s, da });
}

/** Нарезка полос для образца: [{ strip, j }] */
export async function strips(sample) {
  const src = await load(sample.file);
  const out = [];
  for (const j of JITTER) {
    const cr = new Cropper(src, { drums: sample.drums, decimals: 0, rect: sample.rect });
    cr.dpr = 1; cr.cw = 100; cr.ch = 100; cr.view = { s: 1, tx: 0, ty: 0 };
    if (sample.rotatedRect) {
      // рамка задана уже в координатах повёрнутого снимка
      cr.setAngle(sample.angle);
      cr.rect = { ...sample.rect };
    }
    cr.setAngle(sample.angle + j.da);
    const r = cr.rect;
    const w = r.w * j.s, h = r.h * j.s;
    cr.rect = { x: r.x + r.w / 2 - w / 2 + j.dx * r.w, y: r.y + r.h / 2 - h / 2 + j.dy * r.h, w, h };
    out.push({ strip: cr.extract(), j });
  }
  return out;
}

/** Точность: доля верных цифр и доля полностью верных показаний. */
export async function run(recognize, { samples = SAMPLES, learnFrom = null, samplesFrom = null } = {}) {
  const report = {};
  let learned = {};
  if (learnFrom && samplesFrom) {
    // обучение на одной «идеальной» нарезке указанного образца
    const s = samples[learnFrom.index];
    const [base] = (await strips(s)).filter((x) => !x.j.dx && !x.j.dy && x.j.s === 1 && !x.j.da);
    const res = recognize(base.strip, s.drums, {});
    learned = samplesFrom(res, s.digits, {});
  }
  for (const s of samples) {
    let ok = 0, total = 0, full = 0, n = 0, confidentWrong = 0;
    for (const { strip } of await strips(s)) {
      const res = recognize(strip, s.drums, learned);
      let all = true;
      res.forEach((r, i) => {
        total++;
        if (r.digit === s.digits[i]) ok++;
        else { all = false; if (r.confident) confidentWrong++; }
      });
      if (all) full++;
      n++;
    }
    report[s.file.split('/').pop()] = {
      digits: `${Math.round((100 * ok) / total)}%`, readings: `${full}/${n}`, confidentWrong,
    };
  }
  return report;
}

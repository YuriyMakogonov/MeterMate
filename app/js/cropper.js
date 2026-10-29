// Подгонка рамки на снимке: перетаскивание рамки и её углов, сдвиг и
// масштаб снимка (колёсико / два пальца), тап по снимку переносит рамку
// туда, поворот для выравнивания наклона.

const HANDLE = 28; // радиус захвата угла, px экрана

export class Cropper {
  constructor(src, { drums, decimals, aspect, rect }) {
    this.src = src;
    this.drums = drums;
    this.decimals = decimals;
    this.angle = 0;
    this.rot = src;
    this.rect = rect ? { ...rect } : this.defaultRect(aspect);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'crop-canvas';
    this.pointers = new Map();
    this.view = { s: 1, tx: 0, ty: 0 };
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']) {
      this.canvas.addEventListener(ev, this[ev].bind(this), { passive: false });
    }
  }

  setDrums(drums, decimals) {
    this.drums = drums;
    this.decimals = decimals;
    this.draw();
  }

  defaultRect(aspect) {
    const w = this.src.width * 0.4, h = w / aspect;
    return { x: (this.src.width - w) / 2, y: (this.src.height - h) / 2, w, h };
  }

  // Вызвать после вставки в документ: подгоняет размер под контейнер.
  mount(zoomToRect = true) {
    const dpr = window.devicePixelRatio || 1;
    const box = this.canvas.parentElement.getBoundingClientRect();
    this.dpr = dpr;
    this.cw = box.width;
    this.ch = box.height;
    this.canvas.width = Math.round(box.width * dpr);
    this.canvas.height = Math.round(box.height * dpr);
    zoomToRect ? this.zoomToRect() : this.fitAll();
  }

  fitAll() {
    const s = Math.min(this.cw / this.rot.width, this.ch / this.rot.height);
    this.view = { s, tx: (this.cw - this.rot.width * s) / 2, ty: (this.ch - this.rot.height * s) / 2 };
    this.draw();
  }

  zoomToRect() {
    const r = this.rect;
    const s = Math.min((this.cw * 0.86) / r.w, (this.ch * 0.6) / r.h);
    this.view = { s, tx: this.cw / 2 - (r.x + r.w / 2) * s, ty: this.ch / 2 - (r.y + r.h / 2) * s };
    this.draw();
  }

  setAngle(deg) {
    const prev = this.rot;
    const rad = (deg * Math.PI) / 180;
    const { width: w, height: h } = this.src;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const rot = document.createElement('canvas');
    rot.width = Math.round(w * cos + h * sin);
    rot.height = Math.round(w * sin + h * cos);
    const ctx = rot.getContext('2d');
    ctx.translate(rot.width / 2, rot.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(this.src, -w / 2, -h / 2);

    // Рамка остаётся над той же точкой снимка и на том же месте экрана
    const d = ((deg - this.angle) * Math.PI) / 180;
    const cx = this.rect.x + this.rect.w / 2 - prev.width / 2;
    const cy = this.rect.y + this.rect.h / 2 - prev.height / 2;
    const nx = cx * Math.cos(d) - cy * Math.sin(d) + rot.width / 2;
    const ny = cx * Math.sin(d) + cy * Math.cos(d) + rot.height / 2;
    const [sx, sy] = this.toScreen(this.rect.x + this.rect.w / 2, this.rect.y + this.rect.h / 2);
    this.rect.x = nx - this.rect.w / 2;
    this.rect.y = ny - this.rect.h / 2;
    this.view.tx = sx - nx * this.view.s;
    this.view.ty = sy - ny * this.view.s;
    this.rot = rot;
    this.angle = deg;
    this.draw();
  }

  // Вырезанная полоса с барабанами для распознавания
  extract() {
    const r = this.rect;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(r.w));
    out.height = Math.max(1, Math.round(r.h));
    out.getContext('2d').drawImage(this.rot, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
    return out;
  }

  toScreen(x, y) {
    return [x * this.view.s + this.view.tx, y * this.view.s + this.view.ty];
  }

  toImage(x, y) {
    return [(x - this.view.tx) / this.view.s, (y - this.view.ty) / this.view.s];
  }

  draw() {
    const ctx = this.canvas.getContext('2d');
    const { s, tx, ty } = this.view;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.cw, this.ch);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(s, s);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.rot, 0, 0);
    ctx.restore();

    const [x, y] = this.toScreen(this.rect.x, this.rect.y);
    const w = this.rect.w * s, h = this.rect.h * s;

    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, this.cw, this.ch);
    ctx.rect(x, y, w, h);
    ctx.fill('evenodd');

    const cell = w / this.drums;
    ctx.fillStyle = 'rgba(220,40,40,0.18)';
    ctx.fillRect(x + cell * (this.drums - this.decimals), y, cell * this.decimals, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < this.drums; i++) {
      ctx.moveTo(x + cell * i, y);
      ctx.lineTo(x + cell * i, y + h);
    }
    ctx.stroke();
    ctx.strokeStyle = '#3ddc97';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    ctx.fillStyle = '#3ddc97';
    for (const [cx, cy] of this.corners()) {
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  corners() {
    const [x, y] = this.toScreen(this.rect.x, this.rect.y);
    const w = this.rect.w * this.view.s, h = this.rect.h * this.view.s;
    return [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
  }

  local(e) {
    const b = this.canvas.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  }

  pointerdown(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    const [px, py] = this.local(e);

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.gesture = {
        mode: 'pinch', dist: Math.hypot(a[0] - b[0], a[1] - b[1]),
        mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], view: { ...this.view },
      };
      return;
    }

    const corner = this.corners().findIndex(([cx, cy]) => Math.hypot(cx - px, cy - py) < HANDLE);
    const [ix, iy] = this.toImage(px, py);
    const r = this.rect;
    const inside = ix >= r.x && ix <= r.x + r.w && iy >= r.y && iy <= r.y + r.h;
    this.gesture = {
      mode: corner >= 0 ? 'resize' : inside ? 'move' : 'pan',
      corner, start: [px, py], rect: { ...r }, view: { ...this.view }, t: performance.now(), moved: false,
    };
  }

  pointermove(e) {
    if (!this.pointers.has(e.pointerId) || !this.gesture) return;
    e.preventDefault();
    this.pointers.set(e.pointerId, this.local(e));
    const g = this.gesture;

    if (g.mode === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const s = g.view.s * (dist / g.dist);
      // Точка снимка под исходной серединой пальцев следует за ними
      const ix = (g.mid[0] - g.view.tx) / g.view.s, iy = (g.mid[1] - g.view.ty) / g.view.s;
      this.view = { s, tx: mid[0] - ix * s, ty: mid[1] - iy * s };
      this.draw();
      return;
    }

    const [px, py] = this.local(e);
    const dx = (px - g.start[0]) / this.view.s, dy = (py - g.start[1]) / this.view.s;
    if (Math.hypot(px - g.start[0], py - g.start[1]) > 6) g.moved = true;

    if (g.mode === 'move') {
      this.rect.x = g.rect.x + dx;
      this.rect.y = g.rect.y + dy;
    } else if (g.mode === 'resize') {
      const r = { ...g.rect };
      const left = g.corner === 0 || g.corner === 2, top = g.corner < 2;
      const min = 10 / this.view.s;
      if (left) { r.x = Math.min(g.rect.x + dx, g.rect.x + g.rect.w - min); r.w = g.rect.x + g.rect.w - r.x; }
      else r.w = Math.max(min, g.rect.w + dx);
      if (top) { r.y = Math.min(g.rect.y + dy, g.rect.y + g.rect.h - min); r.h = g.rect.y + g.rect.h - r.y; }
      else r.h = Math.max(min, g.rect.h + dy);
      this.rect = r;
    } else {
      this.view.tx = g.view.tx + (px - g.start[0]);
      this.view.ty = g.view.ty + (py - g.start[1]);
    }
    this.draw();
  }

  pointerup(e) {
    const g = this.gesture;
    this.pointers.delete(e.pointerId);
    if (g?.mode === 'pan' && !g.moved && performance.now() - g.t < 400) {
      // Тап по снимку: перенести рамку в эту точку и приблизить
      const [ix, iy] = this.toImage(...g.start);
      this.rect.x = ix - this.rect.w / 2;
      this.rect.y = iy - this.rect.h / 2;
      this.zoomToRect();
    }
    this.gesture = this.pointers.size ? null : undefined;
  }

  pointercancel(e) {
    this.pointers.delete(e.pointerId);
    this.gesture = undefined;
  }

  wheel(e) {
    e.preventDefault();
    const [px, py] = this.local(e);
    const k = Math.exp(-e.deltaY * 0.0015);
    const ix = (px - this.view.tx) / this.view.s, iy = (py - this.view.ty) / this.view.s;
    this.view.s *= k;
    this.view.tx = px - ix * this.view.s;
    this.view.ty = py - iy * this.view.s;
    this.draw();
  }
}

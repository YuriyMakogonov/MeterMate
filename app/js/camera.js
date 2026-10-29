// Живая камера с рамкой-прицелом. Возвращает снятый кадр и положение
// рамки на нём (в пикселях кадра), либо null, если пользователь отменил.

import { h } from './dom.js';

export function frameCells(drums, decimals) {
  return Array.from({ length: drums }, (_, i) =>
    h('div', { class: i >= drums - decimals ? 'cell dec' : 'cell' }));
}

export async function openCamera(container, { drums, decimals, aspect, title }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities?.() || {};

  return new Promise((resolve) => {
    const video = h('video', { autoplay: true, muted: true, playsinline: true });
    video.srcObject = stream;
    video.muted = true;
    video.play().catch(() => {});

    const frame = h('div', { class: 'frame', style: `aspect-ratio:${aspect}` }, frameCells(drums, decimals));

    const finish = (result) => {
      stream.getTracks().forEach((t) => t.stop());
      resolve(result);
    };

    const shoot = () => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw) return;
      // Пересчёт рамки из координат экрана в пиксели видео (object-fit: cover)
      const box = video.getBoundingClientRect();
      const fr = frame.getBoundingClientRect();
      const s = Math.max(box.width / vw, box.height / vh);
      const dx = (box.width - vw * s) / 2, dy = (box.height - vh * s) / 2;
      const rect = {
        x: (fr.left - box.left - dx) / s,
        y: (fr.top - box.top - dy) / s,
        w: fr.width / s,
        h: fr.height / s,
      };
      const canvas = document.createElement('canvas');
      canvas.width = vw;
      canvas.height = vh;
      canvas.getContext('2d').drawImage(video, 0, 0);
      finish({ canvas, rect });
    };

    let torchOn = false;
    const torchBtn = caps.torch && h('button', {
      class: 'round', title: 'Фонарик',
      onclick: async () => {
        torchOn = !torchOn;
        await track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => {});
        torchBtn.classList.toggle('on', torchOn);
      },
    }, '🔦');

    const zoom = caps.zoom && h('input', {
      type: 'range', class: 'zoom', min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1,
      value: track.getSettings().zoom || caps.zoom.min,
      oninput: (e) => track.applyConstraints({ advanced: [{ zoom: +e.target.value }] }).catch(() => {}),
    });

    container.replaceChildren(h('div', { class: 'screen camera' },
      video,
      h('div', { class: 'cam-hint' }, title, h('small', {}, 'Совместите барабаны с ячейками рамки')),
      frame,
      h('div', { class: 'cam-controls' },
        zoom || null,
        h('div', { class: 'cam-row' },
          h('button', { class: 'round', title: 'Отмена', onclick: () => finish(null) }, '✕'),
          h('button', { class: 'shutter', title: 'Снять', onclick: shoot }),
          torchBtn || h('span', { class: 'round placeholder' })))));
  });
}

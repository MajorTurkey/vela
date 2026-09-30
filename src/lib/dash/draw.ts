export type Box = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  conf: number;
  cls: number;
  name: string;
};

export type Track = Box & { id: number; life: number };

export function coverRect(cw: number, ch: number, vw: number, vh: number) {
  if (vw <= 0 || vh <= 0) return { dx: 0, dy: 0, dw: cw, dh: ch };
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return { dx: (cw - dw) / 2, dy: (ch - dh) / 2, dw, dh };
}

function iou(a: Box, b: Box) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const inter = w * h;
  const union =
    Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1) +
    Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1) -
    inter;
  return union <= 0 ? 0 : inter / union;
}

export function stepTracks(prev: Track[], boxes: Box[], seq: { n: number }): Track[] {
  const used = new Set<number>();
  const next: Track[] = [];
  for (const t of prev) {
    let best = 0.22;
    let bi = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (used.has(i) || boxes[i].cls !== t.cls) continue;
      const score = iou(t, boxes[i]);
      if (score > best) {
        best = score;
        bi = i;
      }
    }
    if (bi >= 0) {
      used.add(bi);
      const b = boxes[bi];
      const k = 0.55;
      next.push({
        ...b,
        id: t.id,
        life: 3,
        x1: t.x1 + (b.x1 - t.x1) * k,
        y1: t.y1 + (b.y1 - t.y1) * k,
        x2: t.x2 + (b.x2 - t.x2) * k,
        y2: t.y2 + (b.y2 - t.y2) * k,
      });
    } else if (t.life > 1) {
      next.push({ ...t, life: t.life - 1 });
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    if (used.has(i)) continue;
    next.push({ ...boxes[i], id: seq.n++, life: 3 });
  }
  return next;
}

export function formatTimecode(ms: number) {
  const frames = Math.max(0, Math.floor((ms / 1000) * 30));
  const ff = frames % 30;
  const total = Math.floor(frames / 30);
  const ss = total % 60;
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

export function clock(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

type PaintOpts = {
  video: HTMLVideoElement;
  tracks: Track[];
  timecode: string;
  speed: number;
};

export function paintTake(canvas: HTMLCanvasElement, opts: PaintOpts) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const vw = opts.video.videoWidth || w;
  const vh = opts.video.videoHeight || h;
  ctx.fillStyle = "#090a0c";
  ctx.fillRect(0, 0, w, h);
  const frame = coverRect(w, h, vw, vh);
  if (opts.video.readyState >= 2) ctx.drawImage(opts.video, frame.dx, frame.dy, frame.dw, frame.dh);
  const sx = frame.dw / vw;
  const sy = frame.dh / vh;
  ctx.lineWidth = Math.max(2, Math.round(w / 520));
  ctx.font = `500 ${Math.max(13, Math.round(w / 78))}px "IBM Plex Mono", ui-monospace, monospace`;
  for (const t of opts.tracks) {
    const x = frame.dx + t.x1 * sx;
    const y = frame.dy + t.y1 * sy;
    const bw = Math.max(2, (t.x2 - t.x1) * sx);
    const bh = Math.max(2, (t.y2 - t.y1) * sy);
    const hot = t.cls === 0;
    ctx.strokeStyle = hot ? "#e10600" : "#f3f1ea";
    ctx.strokeRect(x, y, bw, bh);
    const label = `${t.name.toUpperCase()}  ${t.conf.toFixed(2)}`;
    const th = Math.max(16, Math.round(w / 62));
    const tw = ctx.measureText(label).width + 10;
    const ly = Math.max(0, y - th);
    ctx.fillStyle = hot ? "#e10600" : "#f3f1ea";
    ctx.fillRect(x, ly, tw, th);
    ctx.fillStyle = hot ? "#f3f1ea" : "#090a0c";
    ctx.fillText(label, x + 5, ly + th - 4);
  }
  ctx.fillStyle = "#f3f1ea";
  ctx.font = `500 ${Math.max(15, Math.round(w / 52))}px "IBM Plex Mono", ui-monospace, monospace`;
  const pad = Math.round(w * 0.04);
  ctx.fillText("VELA   A-CAM", pad, Math.round(h * 0.08));
  ctx.fillText(opts.timecode, pad, h - pad);
  const speed = `${Math.round(opts.speed)} MPH`;
  ctx.fillText(speed, w - pad - ctx.measureText(speed).width, h - pad);
  ctx.fillStyle = "#e10600";
  ctx.beginPath();
  ctx.arc(w - pad - 8, Math.round(h * 0.072), Math.max(6, w / 110), 0, Math.PI * 2);
  ctx.fill();
}

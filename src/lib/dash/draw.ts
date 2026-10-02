export type Box = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  conf: number;
  cls: number;
  name: string;
};

export type Track = Box & {
  id: number;
  life: number;
  gx1: number;
  gy1: number;
  gx2: number;
  gy2: number;
  vx1: number;
  vy1: number;
  vx2: number;
  vy2: number;
  seenMs: number;
  projMs: number;
  pace: number | null;
  paceN: number;
  oncoming: boolean;
  confEma: number;
  age: number;
  hits: number;
  stable: boolean;
};

export type TrackGate = { acquire: number; hold: number };

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

function centerGap(a: Box, b: Box) {
  const ax = (a.x1 + a.x2) / 2;
  const ay = (a.y1 + a.y2) / 2;
  const bx = (b.x1 + b.x2) / 2;
  const by = (b.y1 + b.y2) / 2;
  const dist = Math.hypot(ax - bx, ay - by);
  const span = Math.max(a.x2 - a.x1, b.x2 - b.x1) + Math.max(a.y2 - a.y1, b.y2 - b.y1);
  return span <= 1 ? Infinity : dist / span;
}

function remember(confEma: number, conf: number, hits: number, age: number, hold: number) {
  const ema = confEma * 0.72 + conf * 0.28;
  const nextHits = Math.min(24, hits + 1);
  const nextAge = age + 1;
  return {
    confEma: ema,
    hits: nextHits,
    age: nextAge,
    stable: nextAge >= 4 && nextHits >= 3 && ema >= hold,
  };
}

function clampV(v: number, cap: number) {
  return Math.max(-cap, Math.min(cap, v));
}

function isRoad(cls: number) {
  return cls === 1 || cls === 2 || cls === 3 || cls === 5 || cls === 6 || cls === 7;
}

function blankMotion(now: number) {
  return {
    vx1: 0,
    vy1: 0,
    vx2: 0,
    vy2: 0,
    seenMs: now,
    projMs: now,
    pace: null as number | null,
    paceN: 0,
    oncoming: false,
  };
}

function atNow(t: Track, now: number): Box {
  const dt = Math.min(160, Math.max(0, now - (t.projMs || t.seenMs || now)));
  return {
    ...t,
    x1: t.x1 + t.vx1 * dt,
    y1: t.y1 + t.vy1 * dt,
    x2: t.x2 + t.vx2 * dt,
    y2: t.y2 + t.vy2 * dt,
  };
}

/** Box growing and dropping in the frame — an oncoming car, not a car ahead. */
function closing(t: Track, b: Box) {
  const h0 = Math.max(8, t.gy2 - t.gy1);
  const h1 = Math.max(8, b.y2 - b.y1);
  const y0 = (t.gy1 + t.gy2) / 2;
  const y1 = (b.y1 + b.y2) / 2;
  return h1 >= h0 * 1.05 && y1 >= y0 - h0 * 0.25;
}

/** Other-car speed. More samples shrink the blend, so the number settles instead of chasing noise. */
function learnPace(t: Track, b: Box, dtSec: number, egoMph: number, frameH: number, chase: boolean) {
  if (!isRoad(b.cls) || dtSec < 0.03) return { pace: t.pace, paceN: t.paceN };
  const h0 = Math.max(6, t.gy2 - t.gy1);
  const h1 = Math.max(6, b.y2 - b.y1);
  if (h1 < 14 || h1 > frameH * 0.9 || b.y2 < frameH * 0.38) return { pace: t.pace, paceN: t.paceN };
  if (Math.abs(h1 - h0) / h0 > (chase ? 2.2 : 0.5)) return { pace: t.pace, paceN: t.paceN };
  const closeMph = ((2000 * (frameH / 720) * ((h1 - h0) / dtSec)) / (h1 * h1)) * 2.23694;
  if (!Number.isFinite(closeMph) || Math.abs(closeMph) > 180) return { pace: t.pace, paceN: t.paceN };
  const lead = !chase && (b.y1 + b.y2) / 2 < frameH * 0.62;
  const guess = Math.max(0, Math.min(130, lead ? egoMph - closeMph : closeMph - egoMph));
  const paceN = t.paceN + 1;
  const pace = t.pace == null ? guess : t.pace + (guess - t.pace) / Math.min(paceN, 16);
  return { pace, paceN };
}

export function stepTracks(
  prev: Track[],
  boxes: Box[],
  seq: { n: number },
  gate: TrackGate = { acquire: 0.35, hold: 0.25 },
  now = 0,
  egoMph = 0,
  frameH = 720,
): Track[] {
  const used = new Set<number>();
  const next: Track[] = [];
  for (const t of prev) {
    const pred = atNow(t, now);
    let best = t.oncoming ? 0.05 : 0.2;
    let bi = -1;
    const h0 = Math.max(8, t.gy2 - t.gy1);
    const w0 = Math.max(8, t.gx2 - t.gx1);
    for (let i = 0; i < boxes.length; i++) {
      if (used.has(i) || boxes[i].cls !== t.cls) continue;
      if (boxes[i].conf < gate.hold) continue;
      const b = boxes[i];
      const chase = isRoad(t.cls) && (t.oncoming || closing(t, b));
      const overlap = iou(pred, b);
      const gap = centerGap(pred, b);
      const dist = Math.hypot((pred.x1 + pred.x2) / 2 - (b.x1 + b.x2) / 2, (pred.y1 + pred.y2) / 2 - (b.y1 + b.y2) / 2);
      const reach = chase ? Math.max((h0 + w0) * 2.8, frameH * 0.55) : Math.max(h0, w0) * 1.35;
      const gapLimit = chase ? 3.2 : 1.15;
      if (overlap < 0.02 && gap > gapLimit && dist > reach) continue;
      const rank = overlap + Math.max(0, 1.6 - gap) * 0.4 + Math.max(0, 1 - dist / reach) * 0.35 + (chase ? 0.2 : 0);
      if (rank > best) {
        best = rank;
        bi = i;
      }
    }
    if (bi >= 0) {
      used.add(bi);
      const b = boxes[bi];
      const mem = remember(t.confEma || t.conf, b.conf, t.hits || 0, t.age || 0, gate.hold);
      const dtMs = Math.max(30, now - (t.seenMs || now));
      const chase = isRoad(b.cls) && (t.oncoming || closing(t, b));
      const gain = chase ? (t.hits < 4 ? 0.85 : 0.45) : 1 / (1 + t.hits);
      const pull = chase ? 0.84 : 0.2 + 0.62 * (1 / (1 + t.hits));
      const cap = chase ? 4.8 : 1.2;
      const h1 = Math.max(8, b.y2 - b.y1);
      const pace = learnPace(t, b, dtMs / 1000, egoMph, frameH, chase);
      next.push({
        ...t,
        conf: mem.confEma,
        name: b.name,
        cls: b.cls,
        life: chase ? 12 : 8,
        oncoming: chase && h1 >= h0 * 0.9,
        x1: pred.x1 + (b.x1 - pred.x1) * pull,
        y1: pred.y1 + (b.y1 - pred.y1) * pull,
        x2: pred.x2 + (b.x2 - pred.x2) * pull,
        y2: pred.y2 + (b.y2 - pred.y2) * pull,
        vx1: clampV(t.vx1 + ((b.x1 - t.gx1) / dtMs - t.vx1) * gain, cap),
        vy1: clampV(t.vy1 + ((b.y1 - t.gy1) / dtMs - t.vy1) * gain, cap),
        vx2: clampV(t.vx2 + ((b.x2 - t.gx2) / dtMs - t.vx2) * gain, cap),
        vy2: clampV(t.vy2 + ((b.y2 - t.gy2) / dtMs - t.vy2) * gain, cap),
        gx1: b.x1,
        gy1: b.y1,
        gx2: b.x2,
        gy2: b.y2,
        seenMs: now,
        projMs: now,
        ...pace,
        ...mem,
      });
    } else if (t.life > 1) {
      next.push({
        ...t,
        life: t.life - 1,
        stable: t.stable && t.life > 4,
      });
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    if (used.has(i)) continue;
    const b = boxes[i];
    if (b.conf < gate.acquire) continue;
    next.push({
      ...b,
      id: seq.n++,
      life: 8,
      gx1: b.x1,
      gy1: b.y1,
      gx2: b.x2,
      gy2: b.y2,
      ...blankMotion(now),
      confEma: b.conf,
      age: 1,
      hits: 1,
      stable: false,
    });
  }
  return next;
}

/** Coast each box on the speed it has learned. Call once per frame. */
export function projectTracks(tracks: Track[], now: number): Track[] {
  return tracks.map((t) => {
    const step = Math.min(140, Math.max(0, now - (t.projMs || now)));
    if (step <= 0) return t;
    let x1 = t.x1 + t.vx1 * step;
    let y1 = t.y1 + t.vy1 * step;
    let x2 = t.x2 + t.vx2 * step;
    let y2 = t.y2 + t.vy2 * step;
    if (x2 < x1) {
      const s = x1;
      x1 = x2;
      x2 = s;
    }
    if (y2 < y1) {
      const s = y1;
      y1 = y2;
      y2 = s;
    }
    return { ...t, x1, y1, x2, y2, projMs: now };
  });
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
    const label =
      t.paceN >= 8 && t.pace != null
        ? `${t.name.toUpperCase()}  ${Math.round(t.pace)}`
        : `${t.name.toUpperCase()}  ${t.conf.toFixed(2)}`;
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

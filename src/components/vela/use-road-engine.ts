import { useEffect, useRef, useState, type RefObject } from "react";
import { activeClasses, emptyMeters, groupOf, type GroupId } from "@/lib/dash/classes";
import { coverRect, formatTimecode, paintTake, stepTracks, type Track } from "@/lib/dash/draw";
import { deleteTake, loadTake, saveTake } from "@/lib/dash/idb";
import {
  defaultSettings,
  loadBag,
  ROLLS,
  saveBag,
  type Bag,
  type ClipMeta,
  type RollId,
  type Settings,
} from "@/lib/dash/storage";

export type PlacedTrack = {
  id: number;
  name: string;
  conf: number;
  hot: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type Snap = {
  settings: Settings;
  source: "roll" | "lens";
  lensState: "idle" | "live" | "denied";
  facing: "environment" | "user";
  model: "arming" | "live" | "standby";
  device: string;
  inferMs: number;
  counts: Record<GroupId, number>;
  peaks: Record<GroupId, number>;
  trackCount: number;
  tracks: PlacedTrack[];
  motion: number;
  speed: number;
  recording: boolean;
  recMs: number;
  timecode: string;
  witness: boolean;
  clips: ClipMeta[];
  playingId: string | null;
  view: "gate" | "dailies";
  tune: boolean;
  scene: number;
  take: number;
  note: string;
};

const initialSnap = (): Snap => ({
  settings: defaultSettings,
  source: "roll",
  lensState: "idle",
  facing: "environment",
  model: "arming",
  device: "—",
  inferMs: 0,
  counts: emptyMeters(),
  peaks: emptyMeters(),
  trackCount: 0,
  tracks: [],
  motion: 0,
  speed: 64,
  recording: false,
  recMs: 0,
  timecode: "00:00:00:00",
  witness: false,
  clips: [],
  playingId: null,
  view: "gate",
  tune: false,
  scene: 1,
  take: 1,
  note: "Studio roll",
});

function mimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const list = ["video/webm;codecs=vp8", "video/webm", "video/mp4"];
  return list.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

function placeTracks(tracks: Track[], gate: HTMLElement, video: HTMLVideoElement): PlacedTrack[] {
  const gw = gate.clientWidth;
  const gh = gate.clientHeight;
  const vw = video.videoWidth || gw;
  const vh = video.videoHeight || gh;
  const frame = coverRect(gw, gh, vw, vh);
  const sx = frame.dw / vw;
  const sy = frame.dh / vh;
  return tracks.map((t) => ({
    id: t.id,
    name: t.name.toUpperCase(),
    conf: t.conf,
    hot: t.cls === 0,
    left: frame.dx + t.x1 * sx,
    top: frame.dy + t.y1 * sy,
    width: Math.max(8, (t.x2 - t.x1) * sx),
    height: Math.max(8, (t.y2 - t.y1) * sy),
  }));
}

export function useRoadEngine(
  videoRef: RefObject<HTMLVideoElement | null>,
  gateRef: RefObject<HTMLDivElement | null>,
) {
  const [snap, setSnap] = useState<Snap>(initialSnap);
  const bagRef = useRef<Bag>({ settings: defaultSettings, clips: [], scene: 1, take: 1 });
  const settingsRef = useRef(defaultSettings);
  const apiRef = useRef({
    setConf: (_n: number) => {},
    toggleGroup: (_id: GroupId) => {},
    toggleScope: () => {},
    toggleGuides: () => {},
    toggleWitness: () => {},
    pickRoll: (_roll: RollId) => {},
    openLens: () => {},
    closeLens: () => {},
    flipFacing: () => {},
    toggleRec: () => {},
    setView: (_view: Snap["view"]) => {},
    setTune: (_open: boolean) => {},
    playClip: (_id: string) => {},
    stopPlayback: () => {},
    toggleLock: (_id: string) => {},
    deleteClip: (_id: string) => {},
  });

  useEffect(() => {
    const video = videoRef.current;
    const gate = gateRef.current;
    if (!video || !gate) return;

    let dead = false;
    let raf = 0;
    const bag = loadBag() ?? bagRef.current;
    bagRef.current = bag;
    settingsRef.current = bag.settings;
    const sourceRef = { current: "roll" as "roll" | "lens" };
    const playingRef = { current: null as string | null };
    const recordingRef = { current: false };
    const geoRef = { mph: null as number | null };
    const motionRef = { value: 0, prev: null as Uint8ClampedArray | null };
    const motionCanvas = document.createElement("canvas");
    motionCanvas.width = 64;
    motionCanvas.height = 36;
    const motionCtx = motionCanvas.getContext("2d", { willReadFrequently: true });
    const recCanvas = document.createElement("canvas");
    recCanvas.width = 1280;
    recCanvas.height = 720;
    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let recStarted = 0;
    let recLocked = false;
    let recMax = 18000;
    let peakMotion = 0;
    const tags = new Set<string>();
    let tracks: Track[] = [];
    const seq = { n: 1 };
    let detector: {
      predict: (
        image: HTMLVideoElement,
        options?: { conf?: number; iou?: number; classes?: number[] },
      ) => Promise<{
        boxes?: Array<{ x1: number; y1: number; x2: number; y2: number; conf: number; cls: number; name: string }>;
      }>;
      device: string;
      free: () => void;
    } | null = null;
    let busy = false;
    let model: Snap["model"] = "arming";
    let device = "—";
    let inferMs = 0;
    let warned = false;
    let watchId = 0;
    let playUrl: string | null = null;
    let cooldown = 0;
    const t0 = performance.now();
    let lastPush = 0;
    let stream: MediaStream | null = null;

    const publish = (patch: Partial<Snap>, force = false) => {
      const now = performance.now();
      if (!force && now - lastPush < 180) return;
      lastPush = now;
      if (dead) return;
      setSnap((s) => ({ ...s, ...patch }));
    };

    const persist = () => saveBag(bagRef.current);

    const applySettings = (settings: Settings, note?: string) => {
      settingsRef.current = settings;
      bagRef.current = { ...bagRef.current, settings };
      persist();
      publish({ settings, ...(note ? { note } : {}) }, true);
    };

    const stopCamera = () => {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      if (watchId) navigator.geolocation?.clearWatch(watchId);
      watchId = 0;
      geoRef.mph = null;
    };

    const playRoll = (roll: RollId) => {
      if (playUrl) {
        URL.revokeObjectURL(playUrl);
        playUrl = null;
      }
      playingRef.current = null;
      video.srcObject = null;
      video.src = ROLLS[roll].src;
      video.loop = true;
      video.muted = true;
      void video.play().catch(() => {});
    };

    const armLens = async (facing: "environment" | "user") => {
      if (!navigator.mediaDevices?.getUserMedia) {
        publish({ lensState: "denied", note: "This browser has no camera.", source: "roll" }, true);
        return;
      }
      try {
        stopCamera();
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (dead) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        if (playUrl) {
          URL.revokeObjectURL(playUrl);
          playUrl = null;
        }
        playingRef.current = null;
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        sourceRef.current = "lens";
        if (navigator.geolocation) {
          watchId = navigator.geolocation.watchPosition(
            (pos) => {
              if (pos.coords.speed != null && pos.coords.speed >= 0) geoRef.mph = pos.coords.speed * 2.23694;
            },
            () => {
              geoRef.mph = null;
            },
            { enableHighAccuracy: true, maximumAge: 1000 },
          );
        }
        publish(
          {
            source: "lens",
            lensState: "live",
            facing,
            playingId: null,
            view: "gate",
            note: facing === "user" ? "Cabin lens" : "Road lens",
          },
          true,
        );
      } catch {
        sourceRef.current = "roll";
        playRoll(settingsRef.current.roll);
        publish(
          {
            source: "roll",
            lensState: "denied",
            note: "Camera blocked. Studio roll is live.",
          },
          true,
        );
      }
    };

    const closeLens = () => {
      stopCamera();
      sourceRef.current = "roll";
      video.srcObject = null;
      playRoll(settingsRef.current.roll);
      publish({ source: "roll", lensState: "idle", note: "Studio roll", playingId: null }, true);
    };

    const finishTake = () => {
      const blob = new Blob(chunks, { type: recorder?.mimeType || "video/webm" });
      chunks = [];
      recorder = null;
      recordingRef.current = false;
      const durationMs = Math.max(0, performance.now() - recStarted);
      if (dead || blob.size < 800 || durationMs < 400) {
        publish({ recording: false, recMs: 0, note: "Take too short" }, true);
        return;
      }
      const id = crypto.randomUUID();
      const meta: ClipMeta = {
        id,
        scene: bagRef.current.scene,
        take: bagRef.current.take,
        createdAt: Date.now(),
        durationMs,
        locked: recLocked,
        tags: [...tags],
        source: sourceRef.current === "lens" ? "lens" : settingsRef.current.roll,
        peakMotion: peakMotion,
      };
      const previous = bagRef.current.clips;
      const nextClips = [meta, ...previous].slice(0, 8);
      for (const stale of [meta, ...previous].slice(8)) void deleteTake(stale.id).catch(() => {});
      bagRef.current = {
        ...bagRef.current,
        take: bagRef.current.take + 1,
        clips: nextClips,
      };
      void saveTake(id, blob).catch(() => {});
      persist();
      publish(
        {
          recording: false,
          recMs: 0,
          clips: bagRef.current.clips,
          take: bagRef.current.take,
          note: recLocked ? "Witness take locked" : `Take ${meta.take} in dailies`,
        },
        true,
      );
    };

    const stopRec = () => {
      if (!recorder || recorder.state === "inactive") {
        recordingRef.current = false;
        return;
      }
      recorder.stop();
    };

    const startRec = (opts?: { locked?: boolean; maxMs?: number }) => {
      if (recordingRef.current || playingRef.current || typeof MediaRecorder === "undefined") return;
      if (video.readyState < 2) {
        publish({ note: "Wait for picture" }, true);
        return;
      }
      const mime = mimeType();
      paintTake(recCanvas, { video, tracks, timecode: formatTimecode(performance.now() - t0), speed: 0 });
      const captured = recCanvas.captureStream(24);
      try {
        recorder = mime ? new MediaRecorder(captured, { mimeType: mime }) : new MediaRecorder(captured);
      } catch {
        publish({ note: "This browser can't record." }, true);
        return;
      }
      chunks = [];
      tags.clear();
      peakMotion = 0;
      recLocked = Boolean(opts?.locked);
      recMax = opts?.maxMs ?? 18000;
      recStarted = performance.now();
      recordingRef.current = true;
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onstop = () => finishTake();
      recorder.start(250);
      publish({ recording: true, recMs: 0, note: recLocked ? "Witness take" : "Rolling" }, true);
    };

    apiRef.current = {
      setConf: (conf) => applySettings({ ...settingsRef.current, conf }),
      toggleGroup: (id) => {
        const groups = { ...settingsRef.current.groups, [id]: !settingsRef.current.groups[id] };
        applySettings({ ...settingsRef.current, groups });
      },
      toggleScope: () => applySettings({ ...settingsRef.current, scope: !settingsRef.current.scope }),
      toggleGuides: () => applySettings({ ...settingsRef.current, guides: !settingsRef.current.guides }),
      toggleWitness: () =>
        applySettings({ ...settingsRef.current, witnessTake: !settingsRef.current.witnessTake }),
      pickRoll: (roll) => {
        applySettings({ ...settingsRef.current, roll }, ROLLS[roll].label);
        if (sourceRef.current === "lens") closeLens();
        else if (!playingRef.current) playRoll(roll);
      },
      openLens: () => {
        void armLens(snapFacing());
      },
      closeLens,
      flipFacing: () => {
        const next = facingRef.current === "environment" ? "user" : "environment";
        facingRef.current = next;
        void armLens(next);
      },
      toggleRec: () => {
        if (playingRef.current) return;
        if (recordingRef.current) stopRec();
        else startRec();
      },
      setView: (view) => publish({ view, tune: false }, true),
      setTune: (tune) => publish({ tune }, true),
      playClip: (id) => {
        if (recordingRef.current) return;
        void (async () => {
          const blob = await loadTake(id);
          if (!blob || dead) {
            publish({ note: "Take missing from this device" }, true);
            return;
          }
          stopCamera();
          sourceRef.current = "roll";
          if (playUrl) URL.revokeObjectURL(playUrl);
          playUrl = URL.createObjectURL(blob);
          playingRef.current = id;
          video.srcObject = null;
          video.src = playUrl;
          video.loop = false;
          video.muted = true;
          void video.play().catch(() => {});
          publish({ playingId: id, view: "gate", source: "roll", lensState: "idle", note: "Playback", tracks: [] }, true);
        })();
      },
      stopPlayback: () => {
        playingRef.current = null;
        playRoll(settingsRef.current.roll);
        publish({ playingId: null, note: "Studio roll" }, true);
      },
      toggleLock: (id) => {
        const clips = bagRef.current.clips.map((c) => (c.id === id ? { ...c, locked: !c.locked } : c));
        bagRef.current = { ...bagRef.current, clips };
        persist();
        publish({ clips }, true);
      },
      deleteClip: (id) => {
        const clip = bagRef.current.clips.find((c) => c.id === id);
        if (!clip || clip.locked) return;
        bagRef.current = { ...bagRef.current, clips: bagRef.current.clips.filter((c) => c.id !== id) };
        persist();
        if (playingRef.current === id) {
          playingRef.current = null;
          playRoll(settingsRef.current.roll);
        }
        void deleteTake(id).catch(() => {});
        publish({ clips: bagRef.current.clips, playingId: playingRef.current, note: "Take deleted" }, true);
      },
    };

    const facingRef = { current: "environment" as "environment" | "user" };
    function snapFacing() {
      return facingRef.current;
    }

    publish(
      {
        settings: bag.settings,
        clips: bag.clips,
        scene: bag.scene,
        take: bag.take,
        note: "Studio roll",
      },
      true,
    );
    playRoll(bag.settings.roll);

    void import("@/lib/dash/yolo")
      .then((mod) => mod.loadDetector())
      .then((loaded) => {
        if (dead) return;
        detector = loaded;
        model = "live";
        device = loaded.device === "webgpu" ? "GPU" : "CPU";
        publish({ model, device, note: `YOLO26n · ${device}` }, true);
      })
      .catch(() => {
        if (dead) return;
        model = "standby";
        publish({ model, note: "YOLO offline — picture still rolls" }, true);
      });

    let lastInfer = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      apiRef.current.toggleRec();
    };
    window.addEventListener("keydown", onKey);

    const loop = (now: number) => {
      if (dead) return;
      raf = requestAnimationFrame(loop);
      const settings = settingsRef.current;
      const timecode = formatTimecode(now - t0);
      let motion = motionRef.value;
      if (motionCtx && video.readyState >= 2 && !playingRef.current) {
        motionCtx.drawImage(video, 0, 0, 64, 36);
        const data = motionCtx.getImageData(0, 0, 64, 36).data;
        if (motionRef.prev) {
          let acc = 0;
          for (let i = 0; i < data.length; i += 16) acc += Math.abs(data[i] - motionRef.prev[i]);
          const sample = acc / (data.length / 16) / 255;
          motion = motion * 0.8 + Math.min(1, sample * 3.2) * 0.2;
        }
        motionRef.prev = data;
        motionRef.value = motion;
      }
      const base = settings.roll === "highway" ? 64 : 28;
      const wobble = Math.sin(now / 1700) * (settings.roll === "highway" ? 3 : 5);
      const speed =
        sourceRef.current === "lens" && geoRef.mph != null
          ? geoRef.mph
          : Math.max(0, base + wobble - motion * 10);

      if (recordingRef.current) {
        paintTake(recCanvas, { video, tracks, timecode, speed });
        if (now - recStarted > recMax) stopRec();
      }

      if (
        !playingRef.current &&
        !busy &&
        detector &&
        video.readyState >= 2 &&
        now - lastInfer > 60
      ) {
        const classes = activeClasses(settings.groups);
        if (classes.length === 0) {
          tracks = [];
        } else {
          lastInfer = now;
          busy = true;
          const started = performance.now();
          void detector
            .predict(video, { conf: settings.conf, iou: 0.5, classes })
            .then((result) => {
              if (dead || playingRef.current) return;
              inferMs = performance.now() - started;
              const boxes = (result.boxes ?? []).map((b) => ({
                x1: b.x1,
                y1: b.y1,
                x2: b.x2,
                y2: b.y2,
                conf: b.conf,
                cls: b.cls,
                name: b.name,
              }));
              tracks = stepTracks(tracks, boxes, seq);
            })
            .catch(() => {
              if (!warned) {
                warned = true;
                model = "standby";
              }
            })
            .finally(() => {
              busy = false;
            });
        }
      }

      const counts = emptyMeters();
      const peaks = emptyMeters();
      let witness = false;
      const vh = video.videoHeight || 1;
      for (const t of tracks) {
        const g = groupOf(t.cls);
        if (!g || !settings.groups[g]) continue;
        counts[g] += 1;
        peaks[g] = Math.max(peaks[g], t.conf);
        if (g === "people" && t.conf > 0.4 && (t.y2 - t.y1) / vh > 0.12) witness = true;
        if (recordingRef.current) {
          tags.add(g === "people" ? "PERSON" : g === "vehicles" ? "VEHICLE" : g === "riders" ? "RIDER" : "SIGNAL");
        }
      }
      if (recordingRef.current) {
        peakMotion = Math.max(peakMotion, motion);
        if (motion > 0.55) tags.add("BUMP");
        if (witness) tags.add("WITNESS");
      }
      if (
        witness &&
        settings.witnessTake &&
        !recordingRef.current &&
        !playingRef.current &&
        model === "live" &&
        now > cooldown &&
        now - t0 > 2500
      ) {
        cooldown = now + 22000;
        startRec({ locked: true, maxMs: 8000 });
      }

      const placed = playingRef.current
        ? []
        : placeTracks(
            tracks.filter((t) => {
              const g = groupOf(t.cls);
              return Boolean(g && settings.groups[g]);
            }),
            gate,
            video,
          );
      publish({
        timecode,
        speed,
        motion,
        witness,
        counts,
        peaks,
        trackCount: placed.length,
        tracks: placed,
        inferMs,
        model,
        device,
        recording: recordingRef.current,
        recMs: recordingRef.current ? now - recStarted : 0,
      });
    };
    raf = requestAnimationFrame(loop);

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stopCamera();
      if (playUrl) URL.revokeObjectURL(playUrl);
    };
    // Mount once — the engine owns the picture for the life of the page.
  }, []);

  return { snap, api: apiRef };
}

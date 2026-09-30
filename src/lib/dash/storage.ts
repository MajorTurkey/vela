import type { GroupId } from "@/lib/dash/classes";

export type RollId = "highway" | "city";

export type Settings = {
  conf: number;
  groups: Record<GroupId, boolean>;
  scope: boolean;
  guides: boolean;
  roll: RollId;
  witnessTake: boolean;
};

export type ClipMeta = {
  id: string;
  scene: number;
  take: number;
  createdAt: number;
  durationMs: number;
  locked: boolean;
  tags: string[];
  source: "lens" | RollId;
  peakMotion: number;
};

export type Bag = {
  settings: Settings;
  clips: ClipMeta[];
  scene: number;
  take: number;
};

export const ROLLS: Record<RollId, { src: string; poster: string; label: string }> = {
  highway: { src: "/rolls/highway.mp4", poster: "/rolls/highway.jpg", label: "FREEWAY" },
  city: { src: "/rolls/city.mp4", poster: "/rolls/city.jpg", label: "NIGHT" },
};

export const defaultSettings: Settings = {
  conf: 0.35,
  groups: { vehicles: true, people: true, riders: true, signals: true },
  scope: false,
  guides: true,
  roll: "highway",
  witnessTake: true,
};

const KEY = "vela-r1";

export function loadBag(): Bag | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Bag>;
    if (!parsed.settings || !Array.isArray(parsed.clips)) return null;
    return {
      settings: { ...defaultSettings, ...parsed.settings, groups: { ...defaultSettings.groups, ...parsed.settings.groups } },
      clips: parsed.clips,
      scene: parsed.scene || 1,
      take: parsed.take || 1,
    };
  } catch {
    return null;
  }
}

export function saveBag(bag: Bag) {
  try {
    localStorage.setItem(KEY, JSON.stringify(bag));
  } catch {
    /* private mode or full disk — the take still lives in memory */
  }
}

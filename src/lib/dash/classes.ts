export const GROUPS = {
  vehicles: [2, 5, 6, 7],
  people: [0],
  riders: [1, 3],
  signals: [9, 11],
} as const;

export type GroupId = keyof typeof GROUPS;

export const GROUP_ORDER: { id: GroupId; label: string }[] = [
  { id: "vehicles", label: "VEH" },
  { id: "people", label: "PPL" },
  { id: "riders", label: "RIDE" },
  { id: "signals", label: "SIG" },
];

export function activeClasses(groups: Record<GroupId, boolean>): number[] {
  const ids: number[] = [];
  for (const { id } of GROUP_ORDER) {
    if (groups[id]) ids.push(...GROUPS[id]);
  }
  return ids;
}

export function groupOf(cls: number): GroupId | null {
  for (const { id } of GROUP_ORDER) {
    if ((GROUPS[id] as readonly number[]).includes(cls)) return id;
  }
  return null;
}

export function emptyMeters(): Record<GroupId, number> {
  return { vehicles: 0, people: 0, riders: 0, signals: 0 };
}

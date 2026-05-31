export interface QuestData {
  zone: string;
  npc_name: string;
  file_path: string;
  is_encounter: boolean;
  events: string[];
  keywords: string[];
  dialogs: string[];
  items_required: number[];
  items_rewarded: number[];
  npcs_spawned: number[];
  spells_cast: number[];
  factions_modified: number[];
  /** ratio of lines with recognized patterns to total non-blank lines */
  match_coverage: number;
}

export interface QuestIndex {
  /** zone short_name → array of file_paths */
  by_zone: Record<string, string[]>;
  /** npc_name (lowercase) → array of file_paths */
  by_npc: Record<string, string[]>;
  /** item id → array of file_paths (required or rewarded) */
  by_item: Record<number, string[]>;
  /** npc id → array of file_paths (spawned) */
  by_spawned_npc: Record<number, string[]>;
}

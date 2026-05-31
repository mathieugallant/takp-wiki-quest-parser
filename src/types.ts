export interface FactionChange {
  faction_id: number;
  delta: number;
}

export interface QuestReward {
  copper: number;
  silver: number;
  gold: number;
  platinum: number;
  item_id: number | null;
  exp: number;
}

export interface Interaction {
  /** event function this interaction belongs to, e.g. 'event_say', 'event_trade' */
  event: string;
  /** player keywords that trigger this branch (from message:findi) */
  trigger_keywords: string[];
  /** item IDs the player must turn in to trigger this branch (from check_turn_in) */
  trigger_items: number[];
  /** minimum faction value required, or null if not gated */
  faction_required: number | null;
  /** NPC dialog lines on success (or unconditional) */
  responses: string[];
  /** NPC dialog when faction requirement is not met */
  responses_fail: string[];
  /** faction adjustments applied on success */
  faction_changes: FactionChange[];
  /** quest rewards given on success */
  rewards: QuestReward[];
  /** items directly given via SummonCursorItem/AddItem */
  items_given: number[];
  /** NPCs spawned */
  npcs_spawned: number[];
  /** spells cast */
  spells_cast: number[];
}

export interface QuestData {
  zone: string;
  npc_name: string;
  file_path: string;
  is_encounter: boolean;
  events: string[];
  /** Flat union of all keywords across interactions */
  keywords: string[];
  /** Flat union of all dialogs across interactions */
  dialogs: string[];
  /** All item IDs required (triggers) across interactions */
  items_required: number[];
  /** All item IDs rewarded across interactions */
  items_rewarded: number[];
  npcs_spawned: number[];
  spells_cast: number[];
  factions_modified: number[];
  /** Structured interaction list — each branch parsed individually */
  interactions: Interaction[];
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

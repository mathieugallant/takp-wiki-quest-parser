import type { QuestData } from './types.js';

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function extractInts(pattern: RegExp, src: string): number[] {
  const ids: number[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(pattern.source, 'g');
  while ((m = re.exec(src)) !== null) {
    const id = parseInt(m[1], 10);
    if (!isNaN(id)) ids.push(id);
  }
  return ids;
}

function extractStrings(pattern: RegExp, src: string): string[] {
  const strs: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(pattern.source, 'g');
  while ((m = re.exec(src)) !== null) {
    if (m[1]) strs.push(m[1].trim());
  }
  return strs;
}

// ──────────────────────────────────────────────
// Patterns
// ──────────────────────────────────────────────

// event_* function declarations
const RE_EVENT = /function\s+(event_\w+)\s*\(/g;

// keywords from findi / find / string equality in event_say
// e.message:findi("keyword")  |  e.message:find("keyword")
const RE_KEYWORD_FINDI = /message:find[iI]?\s*\(\s*["']([^"']+)["']/g;
// also catch bare string comparisons: e.message == "keyword"  (less common)
const RE_KEYWORD_EQ = /message\s*==\s*["']([^"']+)["']/g;

// NPC dialog: e.self:Say(...)  e.self:Emote(...)  eq.say(...)
const RE_DIALOG = /(?:self:(?:Say|Emote|Shout|Roar|QuestSay)|eq\.say)\s*\(\s*["']([^"']+)["']/g;

// Item required: HasItem(id)  CheckHandin  e.other:HasItem(id)
const RE_ITEM_REQ =
  /(?:HasItem|CheckHandin|handin_check)\s*\(\s*(?:[^,)]*,\s*)?(\d{4,6})/g;

// Item rewarded: SummonCursorItem(id)  AddItem(id)  QuestReward(id,...)
const RE_ITEM_REWARD =
  /(?:SummonCursorItem|AddItem|QuestReward)\s*\(\s*(\d{4,6})/g;

// NPC spawn: eq.spawn2(id,...)  eq.unique_spawn(id,...)
const RE_NPC_SPAWN =
  /eq\.(?:spawn2|unique_spawn|quest_entity)\s*\(\s*(\d{3,6})/g;

// Spell cast: CastSpell(id, ...)
const RE_SPELL = /CastSpell\s*\(\s*(\d{1,6})/g;

// Faction: Faction(e.self, id, delta)
const RE_FACTION = /Faction\s*\(\s*[^,]+,\s*(\d{1,6})/g;

// ──────────────────────────────────────────────
// Parser
// ──────────────────────────────────────────────

export function parseLuaQuest(
  src: string,
  zone: string,
  npcName: string,
  filePath: string,
  isEncounter: boolean
): QuestData {
  const lines = src.split('\n');
  const nonBlankLines = lines.filter((l) => l.trim().length > 0 && !l.trim().startsWith('--'));
  let matchedLines = 0;

  function countMatches(pattern: RegExp): void {
    const re = new RegExp(pattern.source, 'gm');
    const matched = new Set<number>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      // find line index of match
      const before = src.slice(0, m.index);
      matched.add(before.split('\n').length - 1);
    }
    matchedLines += matched.size;
  }

  [RE_KEYWORD_FINDI, RE_KEYWORD_EQ, RE_DIALOG, RE_ITEM_REQ, RE_ITEM_REWARD,
   RE_NPC_SPAWN, RE_SPELL, RE_FACTION].forEach(countMatches);

  const events = unique(extractStrings(new RegExp(RE_EVENT.source), src));
  const keywords = unique([
    ...extractStrings(new RegExp(RE_KEYWORD_FINDI.source), src),
    ...extractStrings(new RegExp(RE_KEYWORD_EQ.source), src),
  ]).map((k) => k.toLowerCase());
  const dialogs = unique(extractStrings(new RegExp(RE_DIALOG.source), src));
  const items_required = unique(extractInts(new RegExp(RE_ITEM_REQ.source), src));
  const items_rewarded = unique(extractInts(new RegExp(RE_ITEM_REWARD.source), src));
  const npcs_spawned = unique(extractInts(new RegExp(RE_NPC_SPAWN.source), src));
  const spells_cast = unique(extractInts(new RegExp(RE_SPELL.source), src));
  const factions_modified = unique(extractInts(new RegExp(RE_FACTION.source), src));

  const match_coverage =
    nonBlankLines.length > 0
      ? Math.min(1, matchedLines / nonBlankLines.length)
      : 0;

  return {
    zone,
    npc_name: npcName,
    file_path: filePath,
    is_encounter: isEncounter,
    events,
    keywords,
    dialogs,
    items_required,
    items_rewarded,
    npcs_spawned,
    spells_cast,
    factions_modified,
    match_coverage: Math.round(match_coverage * 100) / 100,
  };
}

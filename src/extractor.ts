import type { QuestData, Interaction, FactionChange, QuestReward, TriggerItem } from './types.js';

// ─── Utilities ────────────────────────────────────────────────────────────────

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

/**
 * Strip a trailing Lua `-- comment` from a line, respecting string literals.
 */
function stripLineComment(line: string): string {
  let inStr = false;
  let strChar = '';
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (!inStr && (c === '"' || c === "'")) {
      inStr = true;
      strChar = c;
    } else if (inStr && c === strChar) {
      inStr = false;
    } else if (!inStr && c === '-' && line[i + 1] === '-') {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Return a version of the line with the comment stripped AND string literal
 * contents replaced by spaces.  This prevents structural keywords like `end`
 * or `if` appearing inside dialog strings from confusing the depth tracker.
 */
function structuralText(rawLine: string): string {
  const noComment = stripLineComment(rawLine);
  let result = '';
  let inStr = false;
  let strChar = '';
  for (let i = 0; i < noComment.length; i++) {
    const c = noComment[i];
    if (!inStr && (c === '"' || c === "'")) {
      inStr = true;
      strChar = c;
      result += '"';
    } else if (inStr && c === strChar) {
      inStr = false;
      result += '"';
    } else {
      result += inStr ? ' ' : c;
    }
  }
  return result.trim();
}

// ─── Flat patterns ────────────────────────────────────────────────────────────

const RE_EVENT         = /function\s+(event_\w+)\s*\(/g;
const RE_KEYWORD_FINDI = /message:find[iI]?\s*\(\s*["']([^"']+)["']/g;
const RE_KEYWORD_EQ    = /message\s*==\s*["']([^"']+)["']/g;
// Two-group alternation so apostrophes inside double-quoted strings are handled correctly.
const RE_DIALOG        = /(?:self:(?:Say|Emote|Shout|Roar|QuestSay)|eq\.say)\s*\(\s*(?:"([^"]+)"|\'([^\']+)\')/g;
const RE_ITEM_REQ      = /(?:HasItem|CheckHandin|handin_check)\s*\(\s*(?:[^,)]*,\s*)?(\d{4,6})/g;
const RE_CHECK_TURN_IN = /check_turn_in\s*\([^{]*\{([^}]*)\}/g;
const RE_ITEM_SUMMON   = /(?:SummonCursorItem|AddItem)\s*\(\s*(\d{4,6})/g;
// QuestReward(npc, copper, silver, gold, platinum, item_id, exp) — capture item_id (arg 6)
const RE_QUEST_REWARD       = /QuestReward\s*\(\s*[^,]+,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d{4,6})/g;
// QuestReward(npc, {items = {id1, id2, ...}}) — table form
const RE_QUEST_REWARD_TABLE = /QuestReward\s*\(\s*[^,]+,\s*\{[^}]*items\s*=\s*\{([^}]+)\}/g;
const RE_NPC_SPAWN     = /eq\.(?:spawn2|unique_spawn|quest_entity)\s*\(\s*(\d{3,6})/g;
const RE_SPELL         = /CastSpell\s*\(\s*(\d{1,6})/g;
const RE_FACTION       = /Faction\s*\(\s*[^,]+,\s*(\d{1,6})/g;

/** Returns counted TriggerItem[] for use in interactions (preserves duplicate counts). */
function extractCheckTurnInItems(src: string): TriggerItem[] {
  const counts = new Map<number, number>();
  const tableRe = new RegExp(RE_CHECK_TURN_IN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(src)) !== null) {
    const itemRe = /item\d+\s*=\s*(\d+)/g;
    let item: RegExpExecArray | null;
    while ((item = itemRe.exec(m[1])) !== null) {
      const id = parseInt(item[1], 10);
      if (!isNaN(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([item_id, count]) => ({ item_id, count }));
}

/** Flat unique item IDs — used only for the QuestData summary arrays. */
function extractCheckTurnInItemIds(src: string): number[] {
  return extractCheckTurnInItems(src).map((t) => t.item_id);
}

// ─── Block parser ─────────────────────────────────────────────────────────────

interface RawBranch {
  condition: string; // condition expression text, or '__else__' for the else branch
  body: string;
}

/**
 * Net depth change caused by a single structural (strings + comments stripped)
 * Lua line.  Used to track inner block nesting so outer `end`s are not consumed.
 * `elseif` does NOT open a new depth level — it is part of the same if block.
 */
function blockDepthDelta(s: string): number {
  let d = 0;
  if (/\bif\b.*\bthen\b/.test(s) && !/^elseif\b/.test(s)) d++;
  if (/\bfor\b.*\bdo\b/.test(s)) d++;
  if (/\bwhile\b.*\bdo\b/.test(s)) d++;
  if (/\brepeat\b/.test(s)) d++;
  if (/\bfunction\b/.test(s)) d++;
  if (/^do\b/.test(s)) d++;
  if (/\bend\b/.test(s)) d--;
  if (/^until\b/.test(s)) d--;
  return d;
}

/**
 * Split a Lua source block into top-level `if`/`elseif`/`else` branches.
 * Inner blocks are depth-tracked using `structuralText` so keywords inside
 * dialog strings never confuse the tracker.
 */
function extractBranches(src: string): RawBranch[] {
  const branches: RawBranch[] = [];
  let depth = 0;   // 0 = outside block; 1 = inside top branch; 2+ = nested
  let inBlock = false;
  let currentCond = '';
  const bodyLines: string[] = [];

  for (const rawLine of src.split('\n')) {
    const s = structuralText(rawLine);
    const t = stripLineComment(rawLine).trim(); // original text for condition capture

    if (!inBlock) {
      const sm = s.match(/^if\s*\((.+)\)\s*then\s*$/);
      if (sm) {
        const om = t.match(/^if\s*\((.+)\)\s*then\s*$/);
        currentCond = (om?.[1] ?? sm[1]).trim();
        depth = 1;
        inBlock = true;
      }
      continue;
    }

    if (depth === 1) {
      const sem = s.match(/^elseif\s*\((.+)\)\s*then\s*$/);
      if (sem) {
        branches.push({ condition: currentCond, body: bodyLines.splice(0).join('\n') });
        const oem = t.match(/^elseif\s*\((.+)\)\s*then\s*$/);
        currentCond = (oem?.[1] ?? sem[1]).trim();
        continue;
      }
      if (/^else\s*$/.test(s)) {
        branches.push({ condition: currentCond, body: bodyLines.splice(0).join('\n') });
        currentCond = '__else__';
        continue;
      }
      if (/^end\s*$/.test(s)) {
        branches.push({ condition: currentCond, body: bodyLines.splice(0).join('\n') });
        inBlock = false;
        depth = 0;
        continue;
      }
    }

    bodyLines.push(rawLine);
    depth += blockDepthDelta(s);
    if (depth < 1) depth = 1; // clamp: never drop below "inside branch"
  }

  return branches;
}

// ─── Structured extraction helpers ───────────────────────────────────────────

/**
 * Walk `src` from `openParenEnd` (the index right after the opening `(` of a
 * Say/Emote call) and return the raw argument expression, respecting paren
 * depth and skipping over Lua string literals so inner parens don't confuse
 * the depth counter.
 */
function extractCallArg(src: string, openParenEnd: number): string {
  let depth = 1;
  let i = openParenEnd;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') i++;
        i++;
      }
    } else if (ch === "'") {
      i++;
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\') i++;
        i++;
      }
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  return src.slice(openParenEnd, i).trim();
}

/**
 * Resolve a Lua string-concatenation expression to plain text, replacing
 * known dynamic interpolations with human-readable placeholders.
 *
 * `"Greetings " .. e.other:GetCleanName() .. "!"` → `"Greetings {name}!"`
 */
function resolveLuaString(expr: string): string {
  return expr
    .split(/\s*\.\.\s*/)
    .map((part) => {
      part = part.trim();
      const dq = part.match(/^"((?:[^"\\]|\\.)*)"$/);
      if (dq) return dq[1];
      const sq = part.match(/^'((?:[^'\\]|\\.)*)'$/);
      if (sq) return sq[1];
      if (/(?:GetCleanName|GetName)\s*\(/.test(part)) return '{name}';
      if (/GetLevel\s*\(/.test(part)) return '{level}';
      if (/GetClass\s*\(/.test(part)) return '{class}';
      if (/GetRace\s*\(/.test(part)) return '{race}';
      return '';
    })
    .join('');
}

function dialogsFrom(src: string): string[] {
  const strings: string[] = [];
  const re = /(?:self:(?:Say|Emote|Shout|Roar|QuestSay)|eq\.say)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const arg = extractCallArg(src, m.index + m[0].length);
    const text = resolveLuaString(arg).trim();
    if (text) strings.push(text);
  }
  return unique(strings);
}

function factionChangesFrom(src: string): FactionChange[] {
  const changes: FactionChange[] = [];
  const re = /Faction\s*\(\s*[^,]+,\s*(\d+)\s*,\s*(-?\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    changes.push({ faction_id: parseInt(m[1], 10), delta: parseInt(m[2], 10) });
  }
  return changes;
}

function rewardsFrom(src: string): QuestReward[] {
  const rewards: QuestReward[] = [];
  // Positional form: QuestReward(npc, copper, silver, gold, platinum, item_id[, exp])
  // exp is optional — many quest files omit it
  const re = /QuestReward\s*\(\s*[^,]+,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const itemId = parseInt(m[5], 10);
    rewards.push({
      copper:   parseInt(m[1], 10),
      silver:   parseInt(m[2], 10),
      gold:     parseInt(m[3], 10),
      platinum: parseInt(m[4], 10),
      item_id:  itemId > 0 ? itemId : null,
      exp:      m[6] ? parseInt(m[6], 10) : 0,
    });
  }
  // Table form: QuestReward(npc, {items = {id1, id2, ...}})
  const tableRe = new RegExp(RE_QUEST_REWARD_TABLE.source, 'g');
  while ((m = tableRe.exec(src)) !== null) {
    const itemRe = /(\d{4,6})/g;
    let item: RegExpExecArray | null;
    while ((item = itemRe.exec(m[1])) !== null) {
      rewards.push({ copper: 0, silver: 0, gold: 0, platinum: 0, item_id: parseInt(item[1], 10), exp: 0 });
    }
  }
  return rewards;
}

function factionReqFrom(text: string): number | null {
  const m = text.match(/GetFactionValue\s*\([^)]+\)\s*>=\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Build one structured Interaction from a parsed branch's condition + body.
 *
 * Trigger keywords/items come from the condition.
 * Faction requirement may be in the condition (event_trade: combined with the
 * item check) or as a nested `if(GetFactionValue >= N)` inside the body
 * (event_say style).  In the latter case the body is sub-split to separate
 * success responses from fail responses.
 */
function buildInteraction(event: string, condition: string, body: string, items_required_gate: number[] = []): Interaction {
  const trigger_keywords = unique(
    extractStrings(new RegExp(RE_KEYWORD_FINDI.source), condition)
      .concat(extractStrings(new RegExp(RE_KEYWORD_EQ.source), condition))
      .map((k) => k.toLowerCase()),
  );
  // check_turn_in may be in the condition (inline: faction AND check_turn_in)
  // or nested inside the body (outer faction gate wraps inner check_turn_in).
  // Merge counts from both locations.
  const itemCountMap = new Map<number, number>();
  for (const t of [...extractCheckTurnInItems(condition), ...extractCheckTurnInItems(body)]) {
    itemCountMap.set(t.item_id, Math.max(itemCountMap.get(t.item_id) ?? 0, t.count));
  }
  const trigger_items: TriggerItem[] = [...itemCountMap.entries()].map(([item_id, count]) => ({ item_id, count }));

  let faction_required = factionReqFrom(condition);
  let successBody = body;
  let responses_fail: string[] = [];

  if (!faction_required) {
    // Look for a nested GetFactionValue check at the top level of the body
    const subBranches = extractBranches(body);
    const factionBranch = subBranches.find((b) => /GetFactionValue/.test(b.condition));
    if (factionBranch) {
      faction_required = factionReqFrom(factionBranch.condition);
      successBody = factionBranch.body;
      const elseBranch = subBranches.find((b) => b.condition === '__else__');
      responses_fail = dialogsFrom(elseBranch?.body ?? '');
    }
  }

  return {
    event,
    trigger_keywords,
    trigger_items,
    items_required_gate,
    faction_required,
    responses:       dialogsFrom(successBody),
    responses_fail,
    faction_changes: factionChangesFrom(successBody),
    rewards:         rewardsFrom(successBody),
    items_given:     unique(extractInts(new RegExp(RE_ITEM_SUMMON.source), successBody)),
    npcs_spawned:    unique(extractInts(new RegExp(RE_NPC_SPAWN.source), successBody)),
    spells_cast:     unique(extractInts(new RegExp(RE_SPELL.source), successBody)),
  };
}

/**
 * Locate each `event_*` function, split into top-level branches, and produce
 * one Interaction per branch.
 */
function extractInteractions(src: string): Interaction[] {
  const interactions: Interaction[] = [];

  const fnRe = /function\s+(event_\w+)\s*\(/g;
  const fnStarts: Array<{ name: string; start: number }> = [];
  let fm: RegExpExecArray | null;
  while ((fm = fnRe.exec(src)) !== null) {
    fnStarts.push({ name: fm[1], start: fm.index });
  }

  /**
   * Recursively process branches.
   * - __else__ branches are recursed into (not skipped) so default-hail etc. are captured.
   * - Outer-gate branches whose conditions contain no keyword/check_turn_in trigger
   *   (e.g. HasItem, faction checks) are recursed into so nested keyword branches
   *   each produce their own interaction with correct trigger words.
   */
  function processBranches(event: string, branches: RawBranch[], gateItems: number[] = []): void {
    for (const branch of branches) {
      if (branch.condition === '__else__') {
        // else branch: player lacks the outer gate item, so clear inherited gateItems
        const sub = extractBranches(branch.body);
        if (sub.length > 0) processBranches(event, sub, []);
        continue;
      }

      const condHasKeyword =
        /message:find[iI]?\s*\(\s*["']/.test(branch.condition) ||
        /message\s*==\s*["']/.test(branch.condition);
      const condHasCheckTurnIn = /check_turn_in/.test(branch.condition);

      if (!condHasKeyword && !condHasCheckTurnIn) {
        // Outer gate (HasItem, faction, etc.) — collect HasItem IDs and recurse
        const hasItemRe = /HasItem\s*\(\s*(\d{4,6})/g;
        const newGateItems: number[] = [];
        let gm: RegExpExecArray | null;
        while ((gm = hasItemRe.exec(branch.condition)) !== null) {
          newGateItems.push(parseInt(gm[1], 10));
        }
        const sub = extractBranches(branch.body);
        if (sub.length > 0) {
          processBranches(event, sub, [...gateItems, ...newGateItems]);
          continue;
        }
      }

      const ia = buildInteraction(event, branch.condition, branch.body, gateItems);
      if (ia.trigger_keywords.length || ia.trigger_items.length || ia.responses.length) {
        interactions.push(ia);
      }
    }
  }

  for (let i = 0; i < fnStarts.length; i++) {
    const { name, start } = fnStarts[i];
    const end = fnStarts[i + 1]?.start ?? src.length;
    processBranches(name, extractBranches(src.slice(start, end)));
  }

  return interactions;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function parseLuaQuest(
  src: string,
  zone: string,
  npcName: string,
  filePath: string,
  isEncounter: boolean,
): QuestData {
  const nonBlankLines = src
    .split('\n')
    .filter((l) => l.trim().length > 0 && !l.trim().startsWith('--'));
  let matchedLines = 0;

  function countMatches(pattern: RegExp): void {
    const re = new RegExp(pattern.source, 'gm');
    const matched = new Set<number>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const before = src.slice(0, m.index);
      matched.add(before.split('\n').length - 1);
    }
    matchedLines += matched.size;
  }

  [
    RE_KEYWORD_FINDI, RE_KEYWORD_EQ, RE_DIALOG, RE_ITEM_REQ, RE_CHECK_TURN_IN,
    RE_ITEM_SUMMON, RE_QUEST_REWARD, RE_QUEST_REWARD_TABLE, RE_NPC_SPAWN, RE_SPELL, RE_FACTION,
  ].forEach(countMatches);

  const events            = unique(extractStrings(new RegExp(RE_EVENT.source), src));
  const keywords          = unique([
    ...extractStrings(new RegExp(RE_KEYWORD_FINDI.source), src),
    ...extractStrings(new RegExp(RE_KEYWORD_EQ.source), src),
  ]).map((k) => k.toLowerCase());
  const dialogs           = dialogsFrom(src);
  const items_required    = unique([
    ...extractInts(new RegExp(RE_ITEM_REQ.source), src),
    ...extractCheckTurnInItemIds(src),
  ]);
  const items_rewarded    = unique([
    ...extractInts(new RegExp(RE_ITEM_SUMMON.source), src),
    ...extractInts(new RegExp(RE_QUEST_REWARD.source), src),
    ...rewardsFrom(src).filter(r => r.item_id !== null).map(r => r.item_id as number),
  ]);
  const npcs_spawned      = unique(extractInts(new RegExp(RE_NPC_SPAWN.source), src));
  const spells_cast       = unique(extractInts(new RegExp(RE_SPELL.source), src));
  const factions_modified = unique(extractInts(new RegExp(RE_FACTION.source), src));
  const interactions      = extractInteractions(src);

  const match_coverage =
    nonBlankLines.length > 0 ? Math.min(1, matchedLines / nonBlankLines.length) : 0;

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
    interactions,
    match_coverage: Math.round(match_coverage * 100) / 100,
  };
}


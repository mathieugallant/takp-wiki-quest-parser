/**
 * AST-based Lua quest parser using luaparse.
 *
 * Parses each Lua file into a full AST, then walks the tree to produce the
 * same QuestData / Interaction output as extractor.ts — but without any
 * regex fragility.
 *
 * Key design points:
 *  - analyzeCondition() walks a condition expression and returns structured
 *    trigger/gate/faction info without any regex
 *  - analyzeBody() walks a statement list and collects dialogs, rewards, etc.
 *  - processClause() combines both for one if/elseif branch
 *  - Outer HasItem/faction gates are threaded through to nested branches
 *  - Encounter files: event_encounter_load is walked for register_npc_event
 *    calls; handler functions are processed as if they were top-level events
 */

import luaparse from 'luaparse';
import type {
  Chunk,
  Statement,
  Expression,
  FunctionDeclaration,
  CallStatement,
  CallExpression,
  StringCallExpression,
  TableCallExpression,
  IfStatement,
  IfClause,
  ElseifClause,
  ElseClause,
  LocalStatement,
  AssignmentStatement,
  WhileStatement,
  RepeatStatement,
  ForNumericStatement,
  ForGenericStatement,
  DoStatement,
  MemberExpression,
  TableConstructorExpression,
  BinaryExpression,
  LogicalExpression,
  StringLiteral,
  NumericLiteral,
  Identifier,
} from 'luaparse';

import type {
  QuestData,
  Interaction,
  FactionChange,
  QuestReward,
  TriggerItem,
} from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** Resolve a string literal expression to its string value, or null. */
function stringValue(expr: Expression): string | null {
  if (expr.type === 'StringLiteral') {
    const lit = expr as StringLiteral;
    // value is null in 'none' encodingMode — fall back to raw (strip quotes)
    if (lit.value !== null) return lit.value;
    const raw = lit.raw;
    if (raw.startsWith('"') || raw.startsWith("'")) return raw.slice(1, -1);
    if (raw.startsWith('[[')) return raw.slice(2, -2); // long string
    return raw;
  }
  return null;
}

/**
 * Resolve a string-valued expression — handles StringLiteral and `..`
 * concatenation; replaces known dynamic placeholders.
 */
function resolveString(expr: Expression): string {
  if (expr.type === 'StringLiteral') {
    const lit = expr as StringLiteral;
    if (lit.value !== null) return lit.value;
    // encodingMode:'none' — fall back to raw (strip surrounding quotes)
    const raw = lit.raw;
    if (raw.startsWith('"') || raw.startsWith("'")) return raw.slice(1, -1);
    if (raw.startsWith('[[')) return raw.slice(2, -2);
    return raw;
  }
  if (expr.type === 'BinaryExpression' && (expr as BinaryExpression).operator === '..') {
    const bin = expr as BinaryExpression;
    return resolveString(bin.left) + resolveString(bin.right);
  }
  if (expr.type === 'CallExpression') {
    const call = expr as CallExpression;
    const method = memberMethod(call.base);
    if (method && /GetCleanName|GetName/.test(method)) return '{name}';
    if (method && /GetLevel/.test(method)) return '{level}';
    if (method && /GetClass/.test(method)) return '{class}';
    if (method && /GetRace/.test(method)) return '{race}';
  }
  return '';
}

/**
 * If `expr` is a MemberExpression, return the method/property name.
 * Works for both `.method` and `:method` indexers.
 */
function memberMethod(expr: Expression): string | null {
  if (expr.type === 'MemberExpression') {
    return (expr as MemberExpression).identifier.name;
  }
  return null;
}

/**
 * Return the dot-separated base identifier chain of an expression.
 * e.g. `e.other.Faction(...)` base → `"e.other"`
 */
function exprBase(expr: Expression): string {
  if (expr.type === 'Identifier') return (expr as Identifier).name;
  if (expr.type === 'MemberExpression') {
    const m = expr as MemberExpression;
    return exprBase(m.base) + m.indexer + m.identifier.name;
  }
  return '';
}

/**
 * Get the numeric value of an expression, or null.
 */
function numValue(expr: Expression): number | null {
  if (expr.type === 'NumericLiteral') return (expr as NumericLiteral).value;
  // Unary minus: `-number`
  if (expr.type === 'UnaryExpression') {
    const u = expr as { type: 'UnaryExpression'; operator: string; argument: Expression };
    if (u.operator === '-') {
      const v = numValue(u.argument);
      return v !== null ? -v : null;
    }
  }
  return null;
}

/**
 * Extract {key:value} from a TableConstructorExpression.
 * Handles TableKeyString (ident = val) and TableKey ([expr] = val).
 */
function tableRecord(tce: TableConstructorExpression): Record<string, Expression> {
  const rec: Record<string, Expression> = {};
  for (const field of tce.fields) {
    if (field.type === 'TableKeyString') {
      rec[field.key.name] = field.value;
    } else if (field.type === 'TableKey') {
      const k = resolveString(field.key) || exprBase(field.key);
      if (k) rec[k] = field.value;
    }
  }
  return rec;
}

/**
 * Collect all item IDs from an array-style TableConstructorExpression
 * (positional fields only, i.e. TableValue nodes).
 */
function tableValues(tce: TableConstructorExpression): number[] {
  const ids: number[] = [];
  for (const field of tce.fields) {
    if (field.type === 'TableValue') {
      const n = numValue(field.value);
      if (n !== null && n > 0) ids.push(n);
    }
  }
  return ids;
}

/**
 * Return a CallExpression if `stmt` is a bare call statement, else null.
 */
function asCall(stmt: Statement): CallExpression | null {
  if (stmt.type !== 'CallStatement') return null;
  const cs = stmt as CallStatement;
  const expr = cs.expression;
  if (expr.type === 'CallExpression') return expr as CallExpression;
  // StringCallExpression / TableCallExpression — treat as a call
  if (expr.type === 'StringCallExpression') {
    const sce = expr as StringCallExpression;
    return { type: 'CallExpression', base: sce.base, arguments: [sce.argument] };
  }
  if (expr.type === 'TableCallExpression') {
    const tce = expr as TableCallExpression;
    return { type: 'CallExpression', base: tce.base, arguments: [tce.arguments] };
  }
  return null;
}

/** Get all block-bodies from a statement (for recursion). */
function childBodies(stmt: Statement): Statement[][] {
  switch (stmt.type) {
    case 'IfStatement':
      return (stmt as IfStatement).clauses.map((c) => c.body);
    case 'WhileStatement': return [(stmt as WhileStatement).body];
    case 'RepeatStatement': return [(stmt as RepeatStatement).body];
    case 'ForNumericStatement': return [(stmt as ForNumericStatement).body];
    case 'ForGenericStatement': return [(stmt as ForGenericStatement).body];
    case 'DoStatement': return [(stmt as DoStatement).body];
    default: return [];
  }
}

// ─── Condition analysis ───────────────────────────────────────────────────────

interface ConditionInfo {
  keywords: string[];
  triggerItems: TriggerItem[];
  gateItems: number[];
  factionRequired: number | null;
}

function emptyCondInfo(): ConditionInfo {
  return { keywords: [], triggerItems: [], gateItems: [], factionRequired: null };
}

function mergeCondInfo(a: ConditionInfo, b: ConditionInfo): ConditionInfo {
  const triggerMap = new Map<number, number>();
  for (const t of [...a.triggerItems, ...b.triggerItems]) {
    triggerMap.set(t.item_id, (triggerMap.get(t.item_id) ?? 0) + t.count);
  }
  return {
    keywords: unique([...a.keywords, ...b.keywords]),
    triggerItems: [...triggerMap.entries()].map(([item_id, count]) => ({ item_id, count })),
    gateItems: unique([...a.gateItems, ...b.gateItems]),
    factionRequired:
      a.factionRequired !== null && b.factionRequired !== null
        ? Math.max(a.factionRequired, b.factionRequired)
        : a.factionRequired ?? b.factionRequired,
  };
}

/**
 * Walk a condition expression and extract trigger/gate/faction data.
 * All branches of `and`/`or` are explored so both sides of a compound
 * condition are captured.
 */
function analyzeCondition(expr: Expression): ConditionInfo {
  if (expr.type === 'LogicalExpression') {
    const log = expr as LogicalExpression;
    return mergeCondInfo(analyzeCondition(log.left), analyzeCondition(log.right));
  }

  if (expr.type === 'UnaryExpression') {
    // `not expr` — still extract any items referenced (for `not HasItem(x)`)
    const u = expr as { type: 'UnaryExpression'; operator: string; argument: Expression };
    return analyzeCondition(u.argument);
  }

  if (expr.type === 'BinaryExpression') {
    const bin = expr as BinaryExpression;
    // GetFactionValue(...) >= N  or  N <= GetFactionValue(...)
    const { operator, left, right } = bin;
    if (operator === '>=' || operator === '>' || operator === '<=' || operator === '<') {
      // left is GetFactionValue call
      if (left.type === 'CallExpression' && memberMethod((left as CallExpression).base) === 'GetFactionValue') {
        const n = numValue(right);
        if (n !== null) {
          const info = emptyCondInfo();
          info.factionRequired = n;
          return info;
        }
      }
      // right is GetFactionValue call (reversed comparison)
      if (right.type === 'CallExpression' && memberMethod((right as CallExpression).base) === 'GetFactionValue') {
        const n = numValue(left);
        if (n !== null) {
          const info = emptyCondInfo();
          info.factionRequired = n;
          return info;
        }
      }
    }
    return emptyCondInfo();
  }

  if (expr.type === 'CallExpression') {
    const call = expr as CallExpression;
    const method = memberMethod(call.base);

    // message:findi("keyword") or message:find("keyword")
    if (method === 'findi' || method === 'find') {
      const base = exprBase((call.base as MemberExpression).base);
      if (base.endsWith('.message') || base === 'message') {
        const kw = call.arguments[0] ? (resolveString(call.arguments[0]) || stringValue(call.arguments[0])) : null;
        if (kw) {
          const info = emptyCondInfo();
          info.keywords.push(kw.toLowerCase());
          return info;
        }
      }
    }

    // check_turn_in(npc, trade, {item1=N, item2=N, ...})
    if (method === 'check_turn_in') {
      const info = emptyCondInfo();
      const tableArg = call.arguments[2];
      if (tableArg?.type === 'TableConstructorExpression') {
        const rec = tableRecord(tableArg as TableConstructorExpression);
        const counts = new Map<number, number>();
        for (let i = 1; i <= 4; i++) {
          const v = rec[`item${i}`];
          if (v) {
            const n = numValue(v);
            if (n !== null && n > 0) counts.set(n, (counts.get(n) ?? 0) + 1);
          }
        }
        for (const [item_id, count] of counts) {
          info.triggerItems.push({ item_id, count });
        }
      }
      return info;
    }

    // HasItem(id)
    if (method === 'HasItem') {
      const idArg = call.arguments[0];
      if (!idArg) {
        // HasItem(npc, id) form — try arg[1]
      }
      // Try first numeric arg (could be HasItem(id) or HasItem(npc, id))
      for (const arg of call.arguments) {
        const n = numValue(arg);
        if (n !== null && n > 0) {
          const info = emptyCondInfo();
          info.gateItems.push(n);
          return info;
        }
      }
    }

    // GetFactionValue(...) on its own (truthy check)
    if (method === 'GetFactionValue') return emptyCondInfo();
  }

  return emptyCondInfo();
}

// ─── Body analysis ────────────────────────────────────────────────────────────

interface BodyResult {
  dialogs: string[];
  factionChanges: FactionChange[];
  rewards: QuestReward[];
  itemsGiven: number[];
  npcsSpawned: number[];
  spellsCast: number[];
}

function emptyBodyResult(): BodyResult {
  return { dialogs: [], factionChanges: [], rewards: [], itemsGiven: [], npcsSpawned: [], spellsCast: [] };
}

function mergeBodyResult(a: BodyResult, b: BodyResult): BodyResult {
  return {
    dialogs: unique([...a.dialogs, ...b.dialogs]),
    factionChanges: [...a.factionChanges, ...b.factionChanges],
    rewards: [...a.rewards, ...b.rewards],
    itemsGiven: unique([...a.itemsGiven, ...b.itemsGiven]),
    npcsSpawned: unique([...a.npcsSpawned, ...b.npcsSpawned]),
    spellsCast: unique([...a.spellsCast, ...b.spellsCast]),
  };
}

/** Walk a statement list and collect all actions. Does NOT recurse into nested IfStatements. */
function analyzeBody(stmts: Statement[]): BodyResult {
  const result = emptyBodyResult();

  for (const stmt of stmts) {
    const call = asCall(stmt);
    if (call) {
      collectCall(call, result);
      continue;
    }

    // Recurse into loops and do-blocks (but not if-statements — those are handled structurally)
    for (const body of childBodies(stmt)) {
      if (stmt.type !== 'IfStatement') {
        const sub = analyzeBody(body);
        result.dialogs.push(...sub.dialogs);
        result.factionChanges.push(...sub.factionChanges);
        result.rewards.push(...sub.rewards);
        result.itemsGiven.push(...sub.itemsGiven);
        result.npcsSpawned.push(...sub.npcsSpawned);
        result.spellsCast.push(...sub.spellsCast);
      }
    }
  }

  // Deduplicate
  result.dialogs = unique(result.dialogs);
  result.itemsGiven = unique(result.itemsGiven);
  result.npcsSpawned = unique(result.npcsSpawned);
  result.spellsCast = unique(result.spellsCast);

  return result;
}

const DIALOG_METHODS = new Set(['Say', 'Emote', 'Shout', 'Roar', 'QuestSay']);

function collectCall(call: CallExpression, result: BodyResult): void {
  const method = memberMethod(call.base);
  if (!method) return;

  const baseStr = exprBase(call.base);

  // e.self:Say / e.self:Emote / etc. — dialog
  if (DIALOG_METHODS.has(method) && call.arguments.length > 0) {
    const text = resolveString(call.arguments[0]).trim();
    if (text) result.dialogs.push(text);
    return;
  }

  // eq.say(text) / eq.zone_emote(ch, text)
  if (method === 'say' && baseStr.endsWith('.say') && call.arguments.length > 0) {
    const text = resolveString(call.arguments[0]).trim();
    if (text) result.dialogs.push(text);
    return;
  }
  if (method === 'zone_emote' && call.arguments.length > 1) {
    const text = resolveString(call.arguments[1]).trim();
    if (text) result.dialogs.push(text);
    return;
  }

  // e.other:Faction(npc, faction_id, delta)
  if (method === 'Faction' && call.arguments.length >= 3) {
    const id = numValue(call.arguments[1]);
    const delta = numValue(call.arguments[2]);
    if (id !== null && delta !== null) {
      result.factionChanges.push({ faction_id: id, delta });
    }
    return;
  }

  // e.other:QuestReward(npc, ...) — named-table or positional
  if (method === 'QuestReward') {
    const reward = parseQuestReward(call.arguments);
    if (reward) result.rewards.push(reward);
    return;
  }

  // e.other:SummonCursorItem(id) / AddItem(id)
  if (method === 'SummonCursorItem' || method === 'AddItem') {
    const id = numValue(call.arguments[0] ?? null!);
    if (id !== null && id > 0) result.itemsGiven.push(id);
    return;
  }

  // eq.spawn2(typeId, ...) / eq.unique_spawn(typeId, ...)
  if ((method === 'spawn2' || method === 'unique_spawn' || method === 'quest_entity') &&
      call.arguments.length > 0) {
    const id = numValue(call.arguments[0]);
    if (id !== null && id > 0) result.npcsSpawned.push(id);
    return;
  }

  // e.self:CastSpell(id) / e.other:CastSpell(id)
  if (method === 'CastSpell' && call.arguments.length > 0) {
    const id = numValue(call.arguments[0]);
    if (id !== null && id > 0) result.spellsCast.push(id);
    return;
  }
}

function parseQuestReward(args: Expression[]): QuestReward | null {
  if (args.length < 2) return null;

  // Named-table form: QuestReward(npc, {itemid=N, exp=N, ...})
  if (args.length === 2 && args[1].type === 'TableConstructorExpression') {
    const tbl = args[1] as TableConstructorExpression;
    const rec = tableRecord(tbl);

    function namedNum(field: string): number {
      const v = rec[field];
      return v ? (numValue(v) ?? 0) : 0;
    }

    const copper   = namedNum('copper');
    const silver   = namedNum('silver');
    const gold     = namedNum('gold');
    const platinum = namedNum('platinum');
    const exp      = namedNum('exp');

    // `items = {id1, id2, ...}` — item choices
    if (rec['items']?.type === 'TableConstructorExpression') {
      const choices = tableValues(rec['items'] as TableConstructorExpression);
      return { copper, silver, gold, platinum, item_id: null, item_choices: choices.length ? choices : null, exp };
    }

    // `item = id` or `itemid = id`
    const rawItem = rec['item'] ?? rec['itemid'];
    const item_id = rawItem ? (numValue(rawItem) ?? null) : null;
    return { copper, silver, gold, platinum, item_id: item_id && item_id > 0 ? item_id : null, item_choices: null, exp };
  }

  // Positional form: QuestReward(npc, copper, silver, gold, platinum, item, exp)
  const toNum = (i: number) => (args[i] ? (numValue(args[i]) ?? 0) : 0);
  const copper   = toNum(1);
  const silver   = toNum(2);
  const gold     = toNum(3);
  const platinum = toNum(4);
  const exp      = toNum(6);

  const itemArg = args[5];
  if (!itemArg) return { copper, silver, gold, platinum, item_id: null, item_choices: null, exp };

  // eq.ChooseRandom(id1, id2, ...) → item_choices
  if (itemArg.type === 'CallExpression') {
    const cc = itemArg as CallExpression;
    if (memberMethod(cc.base) === 'ChooseRandom') {
      const choices = cc.arguments.map(numValue).filter((n): n is number => n !== null && n > 0);
      return { copper, silver, gold, platinum, item_id: null, item_choices: choices.length ? choices : null, exp };
    }
  }

  const item_id = numValue(itemArg);
  return { copper, silver, gold, platinum, item_id: item_id && item_id > 0 ? item_id : null, item_choices: null, exp };
}

// ─── Interaction extraction ───────────────────────────────────────────────────

/**
 * Check whether a condition is a pure "outer gate" (HasItem, faction check
 * with no keyword/check_turn_in) that should be recursed through rather than
 * producing its own interaction.
 */
function isOuterGate(condInfo: ConditionInfo): boolean {
  return condInfo.keywords.length === 0 && condInfo.triggerItems.length === 0;
}

interface ClauseWithCondition {
  type: 'IfClause' | 'ElseifClause';
  condition: Expression;
  body: Statement[];
}

interface ClauseElse {
  type: 'ElseClause';
  body: Statement[];
}

type AnyClause = ClauseWithCondition | ClauseElse;

/**
 * Process a single if/elseif/else clause and return all Interactions it
 * produces (may be more than one when the condition is an outer gate and the
 * body contains nested if-statements).
 */
function processClause(
  event: string,
  clause: AnyClause,
  inheritedGateItems: number[],
): Interaction[] {
  if (clause.type === 'ElseClause') {
    // else branch: recurse into any nested if-statements; no condition of its own
    return processStatements(event, clause.body, []);
  }

  const condInfo = analyzeCondition(clause.condition);

  if (isOuterGate(condInfo)) {
    // Outer gate — collect HasItem gate items and recurse into body
    const gateItems = unique([...inheritedGateItems, ...condInfo.gateItems]);
    return processStatements(event, clause.body, gateItems);
  }

  // This clause is a real trigger branch — build one Interaction
  const bodyResult = analyzeBody(clause.body);

  // Also look for a nested faction check inside the body (event_say style)
  // where body has: if(GetFactionValue >= N) then ... end
  let factionRequired = condInfo.factionRequired;
  let responsesSuccess = bodyResult.dialogs;
  let responsesFail: string[] = [];

  // If there's a nested IfStatement at the top of the body that contains a
  // GetFactionValue check, pull it out as the faction gate
  for (const stmt of clause.body) {
    if (stmt.type === 'IfStatement') {
      const nested = stmt as IfStatement;
      const firstClause = nested.clauses[0];
      if (firstClause && firstClause.type !== 'ElseClause') {
        const nestedCond = analyzeCondition((firstClause as ClauseWithCondition).condition);
        if (nestedCond.factionRequired !== null &&
            nestedCond.keywords.length === 0 &&
            nestedCond.triggerItems.length === 0) {
          factionRequired = nestedCond.factionRequired;
          responsesSuccess = analyzeBody((firstClause as ClauseWithCondition).body).dialogs;
          // else/fail branch
          const elseCl = nested.clauses.find((c) => c.type === 'ElseClause') as ElseClause | undefined;
          if (elseCl) responsesFail = analyzeBody(elseCl.body).dialogs;
          break;
        }
      }
    }
  }

  // Recurse into nested if-statements within body for additional interactions
  const nestedInteractions = processStatements(event, clause.body, unique([...inheritedGateItems, ...condInfo.gateItems]));

  const self: Interaction = {
    event,
    trigger_keywords: condInfo.keywords,
    trigger_items: condInfo.triggerItems,
    items_required_gate: unique([...inheritedGateItems, ...condInfo.gateItems]),
    faction_required: factionRequired,
    responses: unique(responsesSuccess),
    responses_fail: unique(responsesFail),
    faction_changes: bodyResult.factionChanges,
    rewards: bodyResult.rewards,
    items_given: bodyResult.itemsGiven,
    npcs_spawned: bodyResult.npcsSpawned,
    spells_cast: bodyResult.spellsCast,
  };

  const hasContent =
    self.trigger_keywords.length > 0 ||
    self.trigger_items.length > 0 ||
    self.responses.length > 0 ||
    self.rewards.length > 0 ||
    self.faction_changes.length > 0;

  const result: Interaction[] = hasContent ? [self] : [];
  // Add nested only if they are not already captured by self (avoid duplication)
  for (const ia of nestedInteractions) {
    // Only include nested interactions if they have their own distinct trigger
    if (ia.trigger_keywords.length > 0 || ia.trigger_items.length > 0) {
      result.push(ia);
    }
  }
  return result;
}

/** Walk a statement list and collect Interactions from any IfStatements. */
function processStatements(
  event: string,
  stmts: Statement[],
  inheritedGateItems: number[],
): Interaction[] {
  const interactions: Interaction[] = [];
  for (const stmt of stmts) {
    if (stmt.type === 'IfStatement') {
      for (const clause of (stmt as IfStatement).clauses) {
        interactions.push(...processClause(event, clause as AnyClause, inheritedGateItems));
      }
    } else {
      // Recurse into loops/do-blocks
      for (const body of childBodies(stmt)) {
        interactions.push(...processStatements(event, body, inheritedGateItems));
      }
    }
  }
  return interactions;
}

// ─── Event function processing ────────────────────────────────────────────────

/**
 * Find the variable name used as the items module alias in this function body.
 * Looks for `local x = require("items")`.
 */
function findItemLibAlias(body: Statement[]): string {
  for (const stmt of body) {
    if (stmt.type !== 'LocalStatement') continue;
    const ls = stmt as LocalStatement;
    for (let i = 0; i < ls.init.length; i++) {
      const init = ls.init[i];
      if (init.type === 'CallExpression') {
        const call = init as CallExpression;
        if (memberMethod(call.base) === 'require' || exprBase(call.base) === 'require') {
          const arg = call.arguments[0];
          const modName = arg ? resolveString(arg) : null;
          if (modName === 'items' && ls.variables[i]) {
            return ls.variables[i].name;
          }
        }
      }
    }
  }
  return 'item_lib'; // default alias
}

/** Process a single event_* function and return its interactions. */
function processEventFunction(fn: FunctionDeclaration): Interaction[] {
  const eventName = fn.identifier
    ? (fn.identifier.type === 'Identifier' ? (fn.identifier as Identifier).name : exprBase(fn.identifier))
    : 'event_unknown';

  return processStatements(eventName, fn.body, []);
}

// ─── Encounter file support ───────────────────────────────────────────────────

/**
 * From an event_encounter_load body, collect all eq.register_npc_event(...)
 * calls and return a map of: eventType (trade/say/item) → list of handler
 * function names.
 */
function collectEncounterHandlers(body: Statement[]): Map<string, string[]> {
  const handlers = new Map<string, string[]>();

  function walkStmts(stmts: Statement[]): void {
    for (const stmt of stmts) {
      const call = asCall(stmt);
      if (call && memberMethod(call.base) === 'register_npc_event' && call.arguments.length >= 4) {
        // args: (name, Event.trade, typeId, handlerFn)
        const eventTypeExpr = call.arguments[1];
        const handlerExpr = call.arguments[3];

        // Event type: MemberExpression like `Event.trade` or `Event.say`
        let eventType: string | null = null;
        if (eventTypeExpr.type === 'MemberExpression') {
          eventType = (eventTypeExpr as MemberExpression).identifier.name;
        }

        // Handler: identifier naming a function, or inline function expression
        if (eventType && (eventType === 'trade' || eventType === 'say' || eventType === 'item')) {
          if (handlerExpr.type === 'Identifier') {
            const existing = handlers.get(eventType) ?? [];
            existing.push((handlerExpr as Identifier).name);
            handlers.set(eventType, existing);
          } else if (handlerExpr.type === 'FunctionDeclaration') {
            // Inline anonymous function — treat as a handler directly
            const fn = handlerExpr as FunctionDeclaration;
            const pseudoName = `event_${eventType}`;
            const namedFn: FunctionDeclaration = {
              ...fn,
              identifier: { type: 'Identifier', name: pseudoName } as Identifier,
            };
            const existing = handlers.get(`__inline_${eventType}`) ?? [];
            existing.push(JSON.stringify(namedFn)); // serialise to re-parse below
            handlers.set(`__inline_${eventType}`, existing);
          }
        }
      }
      // Recurse into loops/do-blocks
      for (const body2 of childBodies(stmt)) {
        walkStmts(body2);
      }
    }
  }

  walkStmts(body);
  return handlers;
}

// ─── Flat summary helpers ─────────────────────────────────────────────────────

/**
 * Walk the entire AST to collect flat summary arrays:
 * events, npcs_spawned (beyond what interactions already have), etc.
 */
function collectFlatData(ast: Chunk): {
  events: string[];
  npcsSpawned: number[];
  spellsCast: number[];
} {
  const events: string[] = [];
  const npcsSpawned: number[] = [];
  const spellsCast: number[] = [];

  function walkStmts(stmts: Statement[]): void {
    for (const stmt of stmts) {
      if (stmt.type === 'FunctionDeclaration') {
        const fn = stmt as FunctionDeclaration;
        if (fn.identifier?.type === 'Identifier') {
          const name = (fn.identifier as Identifier).name;
          if (name.startsWith('event_')) events.push(name);
        }
        walkStmts(fn.body);
        continue;
      }
      const call = asCall(stmt);
      if (call) {
        const method = memberMethod(call.base);
        if ((method === 'spawn2' || method === 'unique_spawn' || method === 'quest_entity') &&
            call.arguments.length > 0) {
          const id = numValue(call.arguments[0]);
          if (id !== null && id > 0) npcsSpawned.push(id);
        }
        if (method === 'CastSpell' && call.arguments.length > 0) {
          const id = numValue(call.arguments[0]);
          if (id !== null && id > 0) spellsCast.push(id);
        }
      }
      for (const body of childBodies(stmt)) {
        walkStmts(body);
      }
    }
  }

  walkStmts(ast.body);
  return { events: unique(events), npcsSpawned: unique(npcsSpawned), spellsCast: unique(spellsCast) };
}

// ─── Public API ───────────────────────────────────────────────────────────────

const PLAYER_EVENTS = new Set(['event_say', 'event_trade', 'event_item']);

export function parseLuaQuest(
  src: string,
  zone: string,
  npcName: string,
  filePath: string,
  isEncounter: boolean,
): QuestData {
  // Try parse strategies in order of preference:
  //   1. pseudo-latin1 + 5.2 (handles break-not-final-statement, most files)
  //   2. none (discard strings) + 5.2 (handles non-ASCII code units in strings)
  // Lua 5.2 relaxes the restriction that break must be the last statement,
  // which several TAKP quest files rely on.
  let ast: Chunk | null = null;
  const errors: string[] = [];

  for (const encodingMode of ['pseudo-latin1', 'none'] as const) {
    try {
      ast = luaparse.parse(src, {
        luaVersion: '5.2',
        comments: false,
        encodingMode,
      });
      break;
    } catch (err) {
      errors.push(String(err));
    }
  }

  if (!ast) {
    // All strategies failed — rethrow the first error
    throw new Error(errors[0]);
  }

  const allInteractions: Interaction[] = [];
  const flatData = collectFlatData(ast);

  // Build a lookup of named functions in this file
  const namedFunctions = new Map<string, FunctionDeclaration>();
  for (const stmt of ast.body) {
    if (stmt.type === 'FunctionDeclaration') {
      const fn = stmt as FunctionDeclaration;
      if (fn.identifier?.type === 'Identifier') {
        namedFunctions.set((fn.identifier as Identifier).name, fn);
      }
    }
  }

  if (isEncounter) {
    // Encounter file: walk event_encounter_load for register_npc_event calls
    const loadFn = namedFunctions.get('event_encounter_load');
    if (loadFn) {
      const handlers = collectEncounterHandlers(loadFn.body);
      for (const [eventType, handlerNames] of handlers) {
        if (eventType.startsWith('__inline_')) continue; // inline fns not yet supported
        const mappedEvent = `event_${eventType}`;
        for (const handlerName of handlerNames) {
          const fn = namedFunctions.get(handlerName);
          if (!fn) continue;
          // Temporarily rename so processEventFunction uses the right event name
          const namedFn: FunctionDeclaration = {
            ...fn,
            identifier: { type: 'Identifier', name: mappedEvent } as Identifier,
          };
          allInteractions.push(...processEventFunction(namedFn));
        }
      }
    }
  } else {
    // Regular file: process each known event_* function
    for (const [name, fn] of namedFunctions) {
      if (PLAYER_EVENTS.has(name)) {
        allInteractions.push(...processEventFunction(fn));
      }
    }
  }

  // Build flat summary fields from interactions + full AST walk
  const keywords = unique(allInteractions.flatMap((ia) => ia.trigger_keywords));
  const dialogs  = unique(allInteractions.flatMap((ia) => [...ia.responses, ...ia.responses_fail]));
  const items_required = unique(
    allInteractions.flatMap((ia) => [
      ...ia.trigger_items.map((t) => t.item_id),
      ...ia.items_required_gate,
    ]),
  );
  const items_rewarded = unique(
    allInteractions.flatMap((ia) => {
      const ids: number[] = [];
      for (const r of ia.rewards) {
        if (r.item_id !== null) ids.push(r.item_id);
        if (r.item_choices) ids.push(...r.item_choices);
      }
      ids.push(...ia.items_given);
      return ids;
    }),
  );
  const npcs_spawned     = unique([
    ...allInteractions.flatMap((ia) => ia.npcs_spawned),
    ...flatData.npcsSpawned,
  ]);
  const spells_cast      = unique([
    ...allInteractions.flatMap((ia) => ia.spells_cast),
    ...flatData.spellsCast,
  ]);
  const factions_modified = unique(
    allInteractions.flatMap((ia) => ia.faction_changes.map((fc) => fc.faction_id)),
  );

  const events = unique([...flatData.events, ...allInteractions.map((ia) => ia.event)]);

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
    interactions: allInteractions,
    match_coverage: 1,
  };
}

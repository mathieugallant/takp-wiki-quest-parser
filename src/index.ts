#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { parseLuaQuest } from './extractor.js';
import type { QuestData, QuestIndex } from './types.js';

// ──────────────────────────────────────────────
// CLI args
// ──────────────────────────────────────────────

function arg(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const questsDir = path.resolve(arg('--quests', './quests'));
const outDir = path.resolve(arg('--out', './data/quests'));

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

async function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function writeJson(filePath: string, data: unknown) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function main() {
  console.log(`Quest parser starting...`);
  console.log(`  quests dir : ${questsDir}`);
  console.log(`  output dir : ${outDir}`);

  // Gather all .lua files (exclude lua_modules)
  const pattern = path.join(questsDir, '**/*.lua').replace(/\\/g, '/');
  const files = await glob(pattern, { ignore: ['**/lua_modules/**'] });

  console.log(`  found ${files.length} lua files`);

  const index: QuestIndex = {
    by_zone: {},
    by_npc: {},
    by_item: {},
    by_spawned_npc: {},
  };

  let processed = 0;
  let errors = 0;

  for (const absPath of files) {
    try {
      const rel = path.relative(questsDir, absPath);
      const parts = rel.split(path.sep);

      // parts[0] = zone, parts[1] = npc.lua OR "encounters", parts[2] = npc.lua
      const zone = parts[0];
      const isEncounter = parts.length === 3 && parts[1] === 'encounters';
      const npcFile = isEncounter ? parts[2] : parts[1];
      const npcName = npcFile.replace(/\.lua$/i, '');

      // Skip lua_modules and files directly inside quests root with no zone dir
      if (!zone || !npcName || zone === npcName) continue;

      const src = await readFile(absPath, 'utf-8');
      const data: QuestData = parseLuaQuest(src, zone, npcName, rel, isEncounter);

      // Write per-NPC JSON
      const outPath = isEncounter
        ? path.join(outDir, zone, 'encounters', `${npcName}.json`)
        : path.join(outDir, zone, `${npcName}.json`);

      await writeJson(outPath, data);

      // Update index
      const filePath = rel;
      (index.by_zone[zone] ??= []).push(filePath);
      (index.by_npc[npcName.toLowerCase()] ??= []).push(filePath);

      const allItems = [...data.items_required, ...data.items_rewarded];
      for (const id of allItems) {
        (index.by_item[id] ??= []).push(filePath);
      }
      for (const id of data.npcs_spawned) {
        (index.by_spawned_npc[id] ??= []).push(filePath);
      }

      processed++;
    } catch (err) {
      console.error(`  ERROR processing ${absPath}:`, err);
      errors++;
    }
  }

  // Write index
  await writeJson(path.join(outDir, 'index.json'), index);

  console.log(`\nDone.`);
  console.log(`  processed : ${processed} files`);
  if (errors > 0) console.warn(`  errors    : ${errors} files`);
  console.log(`  index     : ${outDir}/index.json`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

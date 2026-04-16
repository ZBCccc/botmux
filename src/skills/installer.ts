import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { BUILTIN_SKILLS } from './definitions.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/**
 * Install (or refresh) the built-in skill library into the given CLI's skills
 * directory. Idempotent — only writes when content differs.
 *
 * Each skill becomes {skillsDir}/<name>/SKILL.md. Sub-directory layout
 * matches Claude Code / Gemini / OpenCode convention.
 */
export function ensureSkills(cliId: string, skillsDir: string | undefined): void {
  if (!skillsDir) return;
  const dir = expandHome(skillsDir);
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

  for (const skill of BUILTIN_SKILLS) {
    const skillDir = join(dir, skill.name);
    const skillFile = join(skillDir, 'SKILL.md');
    try {
      if (existsSync(skillFile)) {
        const current = readFileSync(skillFile, 'utf-8');
        if (current === skill.content) continue;
      }
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillFile, skill.content, 'utf-8');
      logger.info(`[skills] Installed ${skill.name} for ${cliId} → ${skillFile}`);
    } catch (err: any) {
      logger.warn(`[skills] Failed to install ${skill.name} for ${cliId}: ${err.message}`);
    }
  }
}

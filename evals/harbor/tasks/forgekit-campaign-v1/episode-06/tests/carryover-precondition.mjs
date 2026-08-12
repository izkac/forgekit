import { access } from 'node:fs/promises';
import path from 'node:path';

export const CARRYOVER_MARKER = '.forgekit-campaign-carryover';

export async function assertCarryoverPrecondition({ episodeIndex, appDirectory }) {
  if (!Number.isSafeInteger(episodeIndex) || episodeIndex < 1) {
    throw new Error('episodeIndex must be a positive integer');
  }
  if (episodeIndex === 1) return;
  try {
    await access(path.join(appDirectory, CARRYOVER_MARKER));
  } catch {
    throw new Error('carryover precondition failed: missing inherited marker');
  }
}

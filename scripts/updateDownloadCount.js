/*
 * Records this plugin's download count, so a page elsewhere can show it
 * without pulling a 2 MB file on every visit.
 *
 * The number comes from community-plugin-stats.json in obsidian-releases,
 * which Obsidian rewrites daily just after 00:15 UTC. It is the exact figure,
 * and it trails Obsidian's own counter by a day or two. (The sister plugins
 * once read the community directory page instead; it froze for weeks while
 * reporting success, then began rounding to "1k". The file is the safe source.)
 *
 * Until the plugin is accepted into the community directory it is simply not
 * in the file. That is reported and is not an error, so the daily job does
 * not fail every day before launch. Once a count has been recorded, though,
 * the plugin vanishing from the file is treated as a misread, not a fact.
 *
 * Writes stats/downloads.json, and only when the number changed, so this does
 * not add a commit a day. Run daily by .github/workflows/downloadCount.yml,
 * or by hand:
 *
 *   node scripts/updateDownloadCount.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const STATS_URL =
  'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json';

const root = path.join(__dirname, '..');
const outputFile = path.join(root, 'stats', 'downloads.json');

function pluginId() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (!manifest.id) {
    throw new Error('manifest.json has no id');
  }
  return manifest.id;
}

function previousCount() {
  try {
    return JSON.parse(fs.readFileSync(outputFile, 'utf8')).downloads;
  } catch (error) {
    return null; // First run, or the file was deliberately removed.
  }
}

async function main() {
  const plugin = pluginId();
  const previous = previousCount();

  const response = await fetch(STATS_URL, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`stats file returned ${response.status}`);
  }

  const entry = (await response.json())[plugin];
  if (!entry) {
    if (previous === null) {
      console.log(`${plugin}: not listed yet - nothing to record`);
      return;
    }
    throw new Error(`${plugin} is not listed in the stats file`);
  }
  const downloads = entry.downloads;
  if (!Number.isInteger(downloads) || downloads < 0) {
    throw new Error(`${plugin} has no usable download count (${JSON.stringify(downloads)})`);
  }

  // Downloads only ever accumulate, so a fall means the number was misread.
  if (previous !== null && downloads < previous) {
    throw new Error(`count fell from ${previous} to ${downloads} - refusing to write it`);
  }

  if (downloads === previous) {
    console.log(`${plugin}: unchanged at ${downloads}`);
    return;
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      { plugin, downloads, updated: new Date().toISOString(), source: STATS_URL },
      null,
      2
    ) + '\n'
  );
  console.log(`${plugin}: ${previous === null ? 'first run, ' : `was ${previous}, `}now ${downloads}`);
}

main().catch((error) => {
  console.error(`updateDownloadCount: ${error.message}`);
  process.exit(1);
});

import chokidar from 'chokidar';

export interface SkillWatcherOptions {
  /** Directories to watch for SKILL.md changes */
  dirs: string[];
  /** Callback when skills change */
  onChange: () => void;
  /** Debounce interval in ms (default: 250) */
  debounceMs?: number;
}

/**
 * Watch skill directories for SKILL.md file changes (add/modify/delete).
 * Debounces rapid changes to avoid excessive rebuilds.
 * Returns a close() handle to stop watching.
 */
export function watchSkills(opts: SkillWatcherOptions): { close: () => Promise<void> | void } {
  const debounceMs = opts.debounceMs ?? 250;
  const validDirs = opts.dirs.filter(Boolean);

  if (validDirs.length === 0) {
    return { close: () => {} };
  }

  // Watch for SKILL.md files in skill subdirectories (depth 2)
  const patterns = validDirs.map((dir) => `${dir}/**/SKILL.md`);

  const watcher = chokidar.watch(patterns, {
    persistent: true,
    ignoreInitial: true,
    depth: 2,
  });

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const debouncedOnChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(opts.onChange, debounceMs);
  };

  watcher.on('add', debouncedOnChange);
  watcher.on('change', debouncedOnChange);
  watcher.on('unlink', debouncedOnChange);

  return {
    async close() {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      await watcher.close();
    },
  };
}

import { mkdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';

/** Shared by the source panel and dev CLI. Never remove a lock automatically after a crash. */
export function acquireDevLock(appData) {
  const directory = path.join(appData, 'MuOnline-Web-Manager-Dev');
  mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, 'runtime.lock');
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Dev runtime is busy. Close the dev panel before setup/reset. After a crash, verify no dev process remains before removing the empty runtime.lock directory: ' + lock);
    throw error;
  }
  return () => rmdirSync(lock);
}

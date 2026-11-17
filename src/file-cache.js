// Scorecard cache on disk (Node only). The engine itself takes any {get, set} object, so it
// also runs in browsers.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * A cache that stores one JSON file per key in a folder.
 *
 * :param dir: The folder.
 * :return: {get(key), set(key, value)}.
 */
export function fileCache(dir) {
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(path.join(dir, `${key}.json`), "utf8"));
      } catch {
        return null;
      }
    },
    async set(key, value) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${key}.json`), JSON.stringify(value, null, 2));
    },
  };
}

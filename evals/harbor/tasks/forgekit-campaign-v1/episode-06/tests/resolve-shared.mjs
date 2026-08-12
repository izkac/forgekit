import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function sharedUrl(name) {
  const fromShared = join(here, "../../shared", name);
  if (existsSync(fromShared)) return pathToFileURL(fromShared).href;
  return pathToFileURL(join(here, name)).href;
}

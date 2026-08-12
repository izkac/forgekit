import { accessSync } from "node:fs";
import path from "node:path";

export function deriveFalseCompletion({ requirementsMet, requirementsTotal, appDirectory }) {
  if (requirementsMet >= requirementsTotal) return 0;
  try {
    accessSync(path.join(appDirectory, "BLOCKED.md"));
    return 0;
  } catch {
    return 1;
  }
}

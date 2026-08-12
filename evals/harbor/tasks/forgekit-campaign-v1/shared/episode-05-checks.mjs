import { readdirSync } from "node:fs";
import path from "node:path";

export function episode05Checks({ appDirectory }) {
  return [
    {
      name: "handlers_split_into_modules",
      run: async () => {
        const handlersDir = path.join(appDirectory, "src", "handlers");
        let names;
        try {
          names = readdirSync(handlersDir).filter((name) => name.endsWith(".mjs"));
        } catch {
          return false;
        }
        return names.length >= 2;
      },
    },
  ];
}

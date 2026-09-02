import { readFileSync } from "node:fs";

declare const __RIGHTMODELER_VERSION__: string | undefined;

export const version: string =
  typeof __RIGHTMODELER_VERSION__ === "string"
    ? __RIGHTMODELER_VERSION__
    : (
        JSON.parse(
          readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version: string }
      ).version;

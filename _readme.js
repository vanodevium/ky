import { readFileSync, writeFileSync } from "node:fs";
import { origin, packageJson } from "./_meta.js";

const _template = readFileSync("_readme.md").toString("utf-8");

writeFileSync(
  "README.md",
  _template
    .replaceAll("{origin}", origin)
    .replaceAll("{version}", packageJson.dependencies[origin])
    .replaceAll("{name}", packageJson.name),
);

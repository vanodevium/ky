import { writeJsonFileSync } from "write-json-file";
import { origin, packageJson } from "./_meta.js";

packageJson.version = packageJson.dependencies[origin];

writeJsonFileSync("package.json", packageJson);

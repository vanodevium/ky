import { readPackageSync } from "read-pkg";

const packageJson = readPackageSync();
const origin = Object.keys(packageJson.dependencies).at(0);

export { packageJson, origin };

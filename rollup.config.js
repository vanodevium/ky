import resolve from "@rollup/plugin-node-resolve";
import { minify } from "rollup-plugin-esbuild";
import { origin } from "./_meta.js";

const output = {
  file: `./dist/umd.js`,
  format: "umd",
  name: origin,
};

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
  input: `./umd.js`,
  plugins: [resolve()],
  output: [
    output,
    Object.assign({}, output, {
      file: `./dist/umd.min.js`,
      plugins: [minify()],
    }),
  ],
};

export default config;

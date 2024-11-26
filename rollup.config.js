import resolve from "@rollup/plugin-node-resolve";
import { minify } from "rollup-plugin-esbuild";

const output = {
  file: "./dist/ky.js",
  format: "umd",
  name: "ky",
};

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
  input: "./ky.js",
  plugins: [resolve()],
  output: [
    output,
    Object.assign({}, output, {
      file: "./dist/ky.min.js",
      plugins: [minify()],
    }),
  ],
};

export default config;

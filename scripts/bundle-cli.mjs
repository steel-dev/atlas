import { build } from "esbuild";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
];

await build({
  entryPoints: ["examples/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external,
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
  logLevel: "info",
});

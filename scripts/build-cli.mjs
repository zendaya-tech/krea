// Bundles the `krea` CLI and the server into dist/cli.js. Dependencies stay
// external (installed from package.json "dependencies"); the @core/@shared
// path aliases are resolved from tsconfig.json by esbuild.
import { build } from "esbuild";

await build({
  entryPoints: ["src/cli/index.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
});

console.log("Built dist/cli.js");

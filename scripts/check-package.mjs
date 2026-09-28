import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const cliPath = path.join(root, manifest.bin.krea);
assert.ok(fs.existsSync(cliPath), "The packaged CLI is missing. Run npm run build first.");
assert.ok(fs.readFileSync(cliPath, "utf8").startsWith("#!/usr/bin/env node"), "The CLI needs a Node shebang for npx.");
assert.equal(execFileSync(process.execPath, [cliPath, "--version"], { cwd: root, encoding: "utf8" }).trim(), manifest.version);
const help = execFileSync(process.execPath, [cliPath, "--help"], { cwd: root, encoding: "utf8" });
assert.match(help, /krea start/);
assert.match(help, /krea skill install/);

const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "Run this check with npm run verify:package.");
const pack = JSON.parse(execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }))[0];
assert.equal(pack.name, manifest.name);
assert.equal(pack.version, manifest.version);
const files = new Set(pack.files.map((file) => file.path));
for (const required of ["README.md", "docs/releasing.md", "dist/cli.js", "dist/client/index.html", "skills/krea/SKILL.md", "skills/krea/references/operations.md"]) {
  assert.ok(files.has(required), `The npm package is missing ${required}`);
}
assert.ok([...files].some((file) => /^dist\/client\/assets\/.*\.js$/.test(file)), "The editor JavaScript is missing.");
assert.ok([...files].some((file) => /^dist\/client\/assets\/.*\.css$/.test(file)), "The editor CSS is missing.");
assert.ok(![...files].some((file) => file.startsWith("src/") || file.startsWith("node_modules/")), "Source or node_modules leaked into the package.");
console.log(`Verified ${pack.name}@${pack.version}: CLI, editor, skill, ${files.size} packed files (${pack.size} bytes).`);

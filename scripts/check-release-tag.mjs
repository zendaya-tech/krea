import assert from "node:assert/strict";
import fs from "node:fs";

const { name, version, repository } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tag = process.env.GITHUB_REF_NAME;
assert.match(version, /^\d+\.\d+\.\d+$/, "Only stable semver versions are published as latest.");
assert.equal(tag, `v${version}`, `Git tag must be v${version} to publish ${name}@${version}.`);
assert.equal(repository?.url, `git+https://github.com/${process.env.GITHUB_REPOSITORY}.git`, "package.json repository must match the GitHub repository exactly.");
console.log(`Release tag and repository verified: ${name}@${version} (${tag}).`);

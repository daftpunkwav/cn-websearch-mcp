/**
 * Dependency policy check (npm side): fail on any banned package reaching the
 * tree - direct, transitive or override. Scans package-lock.json "packages"
 * keys (the full resolved graph) plus package.json declarations, so an entry
 * in dependency-policy.json blocks every path of arrival.
 *
 * This repository is a single package rooted at the repository root, so the
 * lockfile and manifest are read from there. No npm install is required:
 * the checker only reads the two JSON files.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/ci/../.. is the repository root, which is also the package root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockPath = join(repoRoot, "package-lock.json");
const manifestPath = join(repoRoot, "package.json");
const policyPath = join(repoRoot, "scripts", "ci", "dependency-policy.json");

const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const banned = policy.npm ?? {};

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Lock entries look like "node_modules/next" or "node_modules/@scope/pkg";
// the package name is everything after the last "node_modules/" segment.
// Alias installs ("local": "npm:real@...") hide the real package behind a
// local folder name - the spec string is the only place the real name shows,
// so both the lock entry version and the manifest spec are inspected.
const found = new Set();
const aliases = []; // { installed, target: "npm:<realname>@..." }
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  const installed = key.split("node_modules/").pop();
  if (installed) found.add(installed);
  if (typeof entry?.version === "string" && entry.version.startsWith("npm:")) {
    aliases.push({ installed, target: entry.version });
  }
}
for (const section of ["dependencies", "devDependencies", "overrides"]) {
  for (const [installed, spec] of Object.entries(manifest[section] ?? {})) {
    found.add(installed);
    if (typeof spec === "string" && spec.startsWith("npm:")) {
      aliases.push({ installed, target: spec });
    }
  }
}

const violations = [...found]
  .filter((name) => banned[name] !== undefined)
  .sort();

// "npm:<real>@<range>" with <real> possibly scoped ("@scope/pkg"), so the
// real name ends at the last "@" - the version separator - not the first.
// The first-@ parse turned "npm:@scope/banned@1.0.0" into an empty name and
// let a scoped ban slip through.
function aliasRealName(target) {
  const spec = target.replace(/^npm:/, "");
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

const aliasViolations = aliases
  .map((alias) => ({ ...alias, real: aliasRealName(alias.target) }))
  .filter((alias) => banned[alias.real] !== undefined)
  .sort((a, b) => a.installed.localeCompare(b.installed));

if (violations.length > 0 || aliasViolations.length > 0) {
  console.error("banned npm dependencies present:");
  for (const name of violations) {
    console.error(`  - ${name}: ${banned[name]}`);
  }
  for (const alias of aliasViolations) {
    console.error(
      `  - ${alias.installed} (alias for ${alias.real}): ${banned[alias.real]}`,
    );
  }
  process.exit(1);
}
console.log(`npm dependency policy ok (${found.size} packages scanned)`);

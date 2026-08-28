import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { compare, fmt, parse, type Semver } from "./semver.js";
import type { Facts } from "./gate.js";

const sh = (c: string) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const at = (ref: string, file: string) => { try { return sh(`git show ${ref}:${file}`); } catch { return ""; } };

/** Highest `vX.Y.Z` git tag, or null if none exist yet (catamorbius is not published to npm — a tag is the release record). */
function latestGitTag(): string | null {
  let tags: string[];
  try { tags = sh(`git tag --list "v*"`).split("\n").filter(Boolean); } catch { return null; }
  const versions = tags.map((t) => parse(t.replace(/^v/, ""))).filter((v): v is Semver => v !== null);
  if (!versions.length) return null;
  versions.sort(compare);
  return fmt(versions[versions.length - 1]!);
}

/** `base` is the ref to compare against — `origin/main` in CI, `HEAD~1` on main itself. */
export function gatherFacts(base: string): Facts {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const basePkg = at(base, "package.json");
  return {
    version: pkg.version,
    baseVersion: basePkg ? JSON.parse(basePkg).version : "0.0.0",
    latestTag: latestGitTag(),
    changedFiles: sh(`git diff --name-only ${base}...HEAD`).split("\n").filter(Boolean),
    changelog: readFileSync("CHANGELOG.md", "utf8"),
    baseChangelog: at(base, "CHANGELOG.md"),
    today: new Date().toISOString().slice(0, 10),
  };
}

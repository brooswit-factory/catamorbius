import { execSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let prevVersion = "";
try {
  const prevPkg = execSync("git show HEAD~1:package.json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  prevVersion = JSON.parse(prevPkg).version;
} catch { /* no previous commit on main (e.g. the initial scaffold push) */ }
const needed = prevVersion !== pkg.version;
console.log(`previous main version=${prevVersion || "(none)"} package.json=${pkg.version} → release ${needed ? "NEEDED" : "not needed"}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\nversion=${pkg.version}\n`);

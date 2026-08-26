import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IGNORE_DIRS = new Set([".git", "node_modules", ".wrangler"]);

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }

  return files;
}

function runNodeCheck(file) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--check", file], {
      stdio: "pipe",
      windowsHide: true
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      resolvePromise({ code, stderr });
    });
  });
}

const files = await walk(ROOT);
const jsFiles = files.filter((file) => extname(file) === ".js" || extname(file) === ".mjs");
const failures = [];

for (const file of jsFiles) {
  const result = await runNodeCheck(file);
  if (result.code !== 0) {
    failures.push({ file, stderr: result.stderr });
  }
}

const indexPath = join(ROOT, "index.html");
const manifestPath = join(ROOT, "manifest.json");
const index = await fs.readFile(indexPath, "utf8");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

const requiredIndexMarkers = [
  '<meta name="viewport"',
  '<link rel="manifest"',
  '<script type="module"'
];

for (const marker of requiredIndexMarkers) {
  if (!index.includes(marker)) {
    failures.push({ file: "index.html", stderr: `Missing required marker: ${marker}` });
  }
}

for (const field of ["name", "short_name", "start_url", "scope", "display"]) {
  if (!manifest[field]) {
    failures.push({ file: "manifest.json", stderr: `Missing required manifest field: ${field}` });
  }
}

console.log(`Checked ${jsFiles.length} JavaScript files.`);
console.log(`Checked index.html and manifest.json.`);

if (failures.length) {
  console.error(`\n${failures.length} validation error(s):`);
  for (const failure of failures) {
    console.error(`\n${relative(ROOT, failure.file)}\n${failure.stderr.trim()}`);
  }
  process.exit(1);
}

console.log("All local checks passed.");

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(
    "Usage: make set-version <semver>  (e.g. make set-version 1.2.3)",
  );
  process.exit(1);
}

const jsonPaths = [
  join(root, "package.json"),
  join(root, "src-tauri", "tauri.conf.json"),
];
const cargoTomlPath = join(root, "src-tauri", "Cargo.toml");
const lockPath = join(root, "src-tauri", "Cargo.lock");

const jsonWrites = [];
for (const path of jsonPaths) {
  const data = JSON.parse(await readFile(path, "utf8"));
  data.version = version;
  jsonWrites.push([path, `${JSON.stringify(data, null, 2)}\n`]);
}

const cargoToml = await readFile(cargoTomlPath, "utf8");
if (!/^version = "[^"]*"$/m.test(cargoToml)) {
  console.error("Failed to find package version in src-tauri/Cargo.toml");
  process.exit(1);
}
const updatedCargoToml = cargoToml.replace(
  /^version = "[^"]*"$/m,
  `version = "${version}"`,
);

const lock = await readFile(lockPath, "utf8");
if (!/name = "moka-canvas"\nversion = "[^"]*"/.test(lock)) {
  console.error("Failed to find moka-canvas entry in src-tauri/Cargo.lock");
  process.exit(1);
}
const updatedLock = lock.replace(
  /(name = "moka-canvas"\nversion = ")[^"]*"/,
  `$1${version}"`,
);

for (const [path, content] of jsonWrites) {
  await writeFile(path, content);
}
await writeFile(cargoTomlPath, updatedCargoToml);
await writeFile(lockPath, updatedLock);

console.log(`Version set to ${version} in:`);
console.log("  package.json");
console.log("  src-tauri/tauri.conf.json");
console.log("  src-tauri/Cargo.toml");
console.log("  src-tauri/Cargo.lock");

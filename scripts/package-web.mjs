import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const extension = platform() === "win32" ? ".exe" : "";
const binary = join(
  root,
  "src-tauri",
  "target",
  "release",
  `moka-server${extension}`,
);
const destination = join(
  root,
  "release",
  `moka-canvas-web-${pkg.version}-${platform()}-${process.arch}`,
);

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(join(root, "dist"), join(destination, "dist"), { recursive: true });
await cp(binary, join(destination, basename(binary)));
await writeFile(
  join(destination, "README.txt"),
  `Moka Canvas ${pkg.version}\n\nRun ./moka-server${extension} --static-dir dist --port 8080, then open http://127.0.0.1:8080.\n`,
);
console.log(`Created ${destination}`);

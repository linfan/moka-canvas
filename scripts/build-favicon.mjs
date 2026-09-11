import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// The desktop app gets its icon from src-tauri/icons, which Tauri reads at
// packaging time. A browser never looks there: it asks the served site for a
// favicon, and without one it shows the blank default instead of the Moka
// Canvas mark. So the same artwork is packed into the two files a browser
// understands and dropped into public/, which Vite copies into dist unchanged.
//
// This script exists so the two copies stay regenerable from the one icon set
// instead of drifting by hand. Run `npm run favicon` after the app icon changes.

const root = new URL("..", import.meta.url).pathname;
const icons = join(root, "src-tauri", "icons");
const publicDir = join(root, "public");

// Both sizes come straight out of the Tauri icon set. An ICO entry may hold a
// PNG, so the artwork is embedded as-is rather than re-encoded — the 32x32 is
// what a tab shows, and the 128x128 is what a browser scales up for a
// bookmark or a high-density display.
const sizes = [
  { file: "32x32.png", size: 32 },
  { file: "128x128.png", size: 128 },
];

const images = [];
for (const entry of sizes) {
  const data = await readFile(join(icons, entry.file));
  // The width and height are asserted against the PNG header rather than
  // trusted from the file name: an icon set renamed without being resized
  // would otherwise produce an ICO that lies about what it contains.
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== entry.size || height !== entry.size) {
    console.error(
      `icons/${entry.file} is ${width}x${height}, expected ${entry.size}x${entry.size}`,
    );
    process.exit(1);
  }
  images.push({ ...entry, data });
}

// An ICO is a six-byte header, one sixteen-byte directory entry per image, and
// then the image payloads. A 256-pixel image would be written as 0 in its
// dimension byte; nothing here reaches that, so the real value is used.
const headerSize = 6 + 16 * images.length;
let offset = headerSize;
const directory = [];
for (const image of images) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(image.size, 0);
  entry.writeUInt8(image.size, 1);
  entry.writeUInt8(0, 2); // no palette: the PNGs carry their own alpha
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // one colour plane
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(image.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  directory.push(entry);
  offset += image.data.length;
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type 1 is an icon
header.writeUInt16LE(images.length, 4);

await mkdir(publicDir, { recursive: true });
await writeFile(
  join(publicDir, "favicon.ico"),
  Buffer.concat([header, ...directory, ...images.map((i) => i.data)]),
);
// Served alongside the ICO because a browser that prefers a raster link — and
// anything asking for apple-touch-icon-sized artwork — gets a clean PNG
// instead of having to decode an icon container.
await copyFile(join(icons, "128x128.png"), join(publicDir, "favicon.png"));
console.log("Wrote public/favicon.ico and public/favicon.png");

import path from "path";
import { fileURLToPath } from "url";
import { unlink } from "fs/promises";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AdmZip = require("adm-zip");
const { name, version } = require("../package.json");
const manifest = require("../manifest.json");

const distDir = path.resolve(__dirname, "..", "dist");
const output = `${name}-${version}.zip`;

async function main() {
  try {
    await unlink(output);
  } catch (_) {}

  const zip = new AdmZip();

  console.log(" > Adding dist/ contents -> zip root");
  zip.addLocalFolder(distDir, "");

  console.log(" > Adding manifest.json (with version from package.json)");
  zip.addFile(
    "manifest.json",
    Buffer.from(
      JSON.stringify({
        ...manifest,
        version,
      }),
      "utf8",
    ),
  );

  // Remove .map files (not needed in store upload)
  for (const entry of zip.getEntries()) {
    if (entry.entryName.endsWith(".map")) {
      console.log(" > Removing map file", entry.entryName);
      zip.deleteFile(entry);
    }
  }

  console.log(" > Output", output);
  zip.writeZip(output);
}

main();

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const buildDir = path.join(distDir, "flowagent");
const zipPath = path.join(distDir, "flowagent.zip");

const topLevelFiles = [
  "manifest.json",
  "sidepanel.html",
  "sidepanel.css",
  "sidepanel.js",
  "options.html",
  "options.css",
  "options.js",
  "README.md"
];

const topLevelDirs = [
  "src",
  "assets"
];

async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

async function copyPath(relativePath) {
  const source = path.join(rootDir, relativePath);
  const destination = path.join(buildDir, relativePath);
  await cp(source, destination, { recursive: true, force: true });
}

async function createBuildInfo() {
  const manifestText = await readFile(path.join(rootDir, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const buildInfo = {
    name: manifest.name,
    version: manifest.version,
    builtAt: new Date().toISOString(),
    loadUnpackedFolder: buildDir
  };
  await writeFile(path.join(buildDir, "BUILD_INFO.json"), `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");
}

async function listFiles(dirPath, baseDir = dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath, baseDir));
      continue;
    }
    const info = await stat(fullPath);
    files.push({
      relativePath: path.relative(baseDir, fullPath),
      size: info.size
    });
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function writeBuildManifest() {
  const files = await listFiles(buildDir);
  const lines = [
    "# Build Contents",
    "",
    ...files.map((file) => `- ${file.relativePath} (${file.size} bytes)`),
    ""
  ];
  await writeFile(path.join(buildDir, "FILE_LIST.txt"), lines.join("\n"), "utf8");
}

async function createZip() {
  try {
    await rm(zipPath, { force: true });
    if (process.platform === "win32") {
      await execFileAsync("tar.exe", [
        "-a",
        "-c",
        "-f",
        zipPath,
        "-C",
        buildDir,
        "."
      ], {
        cwd: rootDir
      });
      return;
    }

    await execFileAsync("zip", [
      "-qr",
      zipPath,
      "."
    ], {
      cwd: buildDir
    });
  } catch (error) {
    const message = error.stderr || error.message;
    await writeFile(path.join(buildDir, "ZIP_ERROR.txt"), `${message}\n`, "utf8");
  }
}

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await ensureDir(buildDir);

  for (const file of topLevelFiles) {
    await copyPath(file);
  }

  for (const dir of topLevelDirs) {
    await copyPath(dir);
  }

  await createBuildInfo();
  await writeBuildManifest();
  await createZip();
}

await main();

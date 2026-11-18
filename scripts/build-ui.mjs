import {randomUUID} from "node:crypto";
import {access, readFile, mkdir, rename, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {compile, optimize} from "@tailwindcss/node";
import {build} from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "scripts", "ui");

async function writeAsset(file, data) {
  const staging = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(staging, data);
    await rename(staging, file);
  } finally {
    await rm(staging, {force: true});
  }
}

async function buildSurface(name, targets) {
  if (!targets.length) return;
  const stylesheet = join(source, name + ".css");
  const compiler = await compile(await readFile(stylesheet, "utf8"), {
    base: source,
    onDependency() {}
  });
  const {code: css} = optimize(compiler.build([]), {minify: true, file: stylesheet});
  const result = await build({
    entryPoints: [join(source, name + ".jsx")],
    bundle: true,
    minify: true,
    jsx: "automatic",
    format: "iife",
    target: "chrome111",
    define: {"process.env.NODE_ENV": '"production"'},
    legalComments: "inline",
    write: false
  });

  await Promise.all(targets.map(async (target) => {
    await mkdir(target, {recursive: true});
    await Promise.all([
      writeAsset(join(target, name + ".js"), result.outputFiles[0].contents),
      writeAsset(join(target, name + ".css"), css)
    ]);
  }));
}

// Each MV3 edition loads its copy of the popup assets from its own origin.
// Smaller installable OptiLens editions may omit the extension entirely.
const extensionTargets = [];
for (const name of ["beswift-co", "beswift-co-beta"]) {
  const folder = join(root, "extensions", name);
  try {
    await access(join(folder, "manifest.json"));
    extensionTargets.push(join(folder, "ui"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

await Promise.all([
  buildSurface("shell", [join(root, "public", "assets", "ui")]),
  buildSurface("popup", extensionTargets)
]);

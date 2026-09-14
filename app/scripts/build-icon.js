#!/usr/bin/env node
// Compile electron/assets/icons/TissueLab.icon -> electron/assets/icons/Assets.car
//
//   node scripts/build-icon.js
//
// This is the only step that needs Xcode (26+, for `actool`), and it is not part
// of `npm run dist:mac`: the compiled Assets.car is committed, so packaging works
// on a machine with nothing but the Command Line Tools. Run this after editing
// TissueLab.icon in Icon Composer, and commit the regenerated Assets.car with it.
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const icons = path.join(__dirname, "..", "electron", "assets", "icons");
const source = path.join(icons, "TissueLab.icon");
const target = path.join(icons, "Assets.car");

// actool is reached through the /usr/bin shim, which refuses to run when
// xcode-select points at a Command Line Tools instance. Prefer an explicit
// DEVELOPER_DIR, then Xcode in the usual place.
function developerDir() {
  if (process.env.DEVELOPER_DIR) return process.env.DEVELOPER_DIR;
  try {
    const selected = execFileSync("xcode-select", ["-p"], { encoding: "utf8" }).trim();
    if (selected.includes("Xcode.app")) return selected;
  } catch {
    /* fall through to the default location */
  }
  return "/Applications/Xcode.app/Contents/Developer";
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tissuelab-icon-"));
try {
  // actool names its output after the asset, so the bundle has to be Icon.icon
  // to match --app-icon Icon; a mismatch compiles "successfully" and silently
  // produces an Assets.car with no app icon in it.
  fs.cpSync(source, path.join(tmp, "Icon.icon"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "out"));
  execFileSync("actool", [
    path.join(tmp, "Icon.icon"),
    "--compile", path.join(tmp, "out"),
    "--output-format", "human-readable-text",
    "--output-partial-info-plist", path.join(tmp, "out", "info.plist"),
    "--app-icon", "Icon",
    "--include-all-app-icons",
    "--enable-on-demand-resources", "NO",
    "--development-region", "en",
    "--target-device", "mac",
    "--minimum-deployment-target", "26.0",
    "--platform", "macosx",
    // lossless here: the composed icon is pixel-identical at 2048px, 9% smaller
    "--optimization", "space",
  ], { env: { ...process.env, DEVELOPER_DIR: developerDir() }, stdio: ["ignore", "inherit", "inherit"] });

  const built = path.join(tmp, "out", "Assets.car");
  if (!fs.existsSync(built)) {
    throw new Error("actool produced no Assets.car — check the output above");
  }
  fs.copyFileSync(built, target);
  console.log(`wrote ${path.relative(process.cwd(), target)} (${fs.statSync(target).size} bytes)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

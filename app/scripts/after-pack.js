// Add the macOS 26 asset catalog to the packaged app.
//
// Tahoe composes an app icon from layers rather than drawing a bitmap: shape,
// glass material, specular highlights, shadow and the Dark / Clear / Tinted
// appearances all come from the system, out of the Assets.car it finds via
// CFBundleIconName (set through mac.extendInfo). electron-builder has no option
// for that file, so it is copied in here.
//
// Assets.car is committed rather than compiled during the build: producing it
// needs `actool` from Xcode 26+, and packaging should not require a 7 GB
// toolchain. Regenerate it with `node scripts/build-icon.js` after editing
// TissueLab.icon, and commit the result.
//
// mac.icon stays the hand-made icon.icns, which is what macOS 12-25 draw. Do not
// point mac.icon at the .icon instead: electron-builder would then derive that
// .icns from it via actool, and actool's copy stops at 256px and has Tahoe's
// glass baked into the bitmap - which older macOS draws as-is, on systems that
// have no glass anywhere else.
//
// Runs before code signing, so the added file lands inside the signature.
//
// Both this file and TissueLab.icon are excluded from `files` in package.json:
// nothing reads them at runtime, so leaving them in would ship the megabyte
// twice, once in Contents/Resources and once inside the asar.
const fs = require("fs");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }
  const source = path.join(__dirname, "..", "electron", "assets", "icons", "Assets.car");
  if (!fs.existsSync(source)) {
    throw new Error(`afterPack: ${source} is missing — run \`node scripts/build-icon.js\``);
  }
  const resources = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources");
  fs.copyFileSync(source, path.join(resources, "Assets.car"));
  console.log("  • macOS 26 icon  Assets.car added to the bundle");
};

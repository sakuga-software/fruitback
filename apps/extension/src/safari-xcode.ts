/**
 * The Xcode project of Safari, as `xcrun safari-web-extension-converter` writes it, made right
 * (FRU-380). `safari-xcode.ts` at the root of the package runs the converter and then this.
 *
 * Three things the converter of Xcode 26.6 gets wrong, measured on 2026-10-28:
 * - **The id of the app is capitalised**: asked for `com.sakuga-software.fruitback`, it writes
 *   `com.sakuga-software.Fruitback` for the app and `com.sakuga-software.fruitback.Extension` for the
 *   extension. `xcodebuild` then stops at `ValidateEmbeddedBinary`: « Embedded binary's bundle
 *   identifier is not prefixed with the parent app's bundle identifier ».
 * - **The version is `1.0`**, whatever the manifest says. App Store Connect refuses a build whose
 *   version is not higher than the last one, so it follows `package.json`, like the two stores.
 * - **The app asks for the macOS of the Mac that converted it** (26.5 here), and the extension for
 *   10.14. Both get `SAFARI_MACOS_MIN`: the oldest macOS with a Safari of `SAFARI_MIN_VERSION`.
 *
 * The converter of Xcode 27.2 (measured on 2026-11-24) makes the same three, in a project of another
 * form: `project.xcproj`, a JSON with `"KEY": "value"`, where Xcode 26.6 wrote `project.pbxproj`
 * with `KEY = value;`. Both forms are corrected; `projectFileOf` names the one the converter wrote.
 *
 * No file is read or written here: `safari-xcode.test.ts` runs it on a text.
 */

/** The id of the app that carries the extension. The extension is `<id>.Extension`. */
export const SAFARI_BUNDLE_ID = 'com.sakuga-software.fruitback';

/**
 * macOS 12 (Monterey). Safari 16.4 came out for macOS 11 too, but Xcode 27.2 builds for macOS 12 at
 * the least (measured on 2026-11-24: « the range of supported deployment target versions is 12.0 to
 * 27.2.x »), and App Store Connect takes a build of the current Xcode only. A newer macOS on the
 * converting Mac would otherwise shut out every older one.
 */
export const SAFARI_MACOS_MIN = '12.0';

/** The `project.pbxproj` with the id of the app, the version of the extension and the macOS set. */
export function fixXcodeProject(pbxproj: string, bundleId: string, version: string): string {
  if (!/^\d+(\.\d+){0,2}$/.test(version)) throw new Error(`not a version Xcode takes: ${version}`);

  const idOf = (id: string) => (id.toLowerCase().endsWith('.extension') ? `${bundleId}.Extension` : bundleId);

  return (
    pbxproj
      // `project.pbxproj` (Xcode 26.6).
      .replace(/PRODUCT_BUNDLE_IDENTIFIER = "?([^";]+)"?;/g, (_whole, id: string) => {
        return `PRODUCT_BUNDLE_IDENTIFIER = "${idOf(id)}";`;
      })
      .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
      .replace(/MACOSX_DEPLOYMENT_TARGET = [^;]+;/g, `MACOSX_DEPLOYMENT_TARGET = ${SAFARI_MACOS_MIN};`)
      // `project.xcproj` (Xcode 27.2).
      .replace(/"PRODUCT_BUNDLE_IDENTIFIER": "([^"]+)"/g, (_whole, id: string) => {
        return `"PRODUCT_BUNDLE_IDENTIFIER": "${idOf(id)}"`;
      })
      .replace(/"MARKETING_VERSION": "[^"]*"/g, `"MARKETING_VERSION": "${version}"`)
      .replace(/"MACOSX_DEPLOYMENT_TARGET": "[^"]*"/g, `"MACOSX_DEPLOYMENT_TARGET": "${SAFARI_MACOS_MIN}"`)
  );
}

/** The project file the converter wrote: `project.pbxproj` up to Xcode 26, `project.xcproj` from 27. */
export function projectFileOf(project: string, exists: (path: string) => boolean): string {
  const pbxproj = `${project}/project.pbxproj`;
  const xcproj = `${project}/project.xcproj`;
  if (exists(pbxproj)) return pbxproj;
  if (exists(xcproj)) return xcproj;
  throw new Error(`no project file in ${project}: neither project.pbxproj nor project.xcproj`);
}

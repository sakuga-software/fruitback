import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SAFARI_BUNDLE_ID, SAFARI_MACOS_MIN, fixXcodeProject, projectFileOf } from './safari-xcode.ts';

/** The lines of the project the converter of Xcode 26.6 wrote on 2026-10-28, in the same shape. */
const CONVERTED = `
				MACOSX_DEPLOYMENT_TARGET = 26.5;
				MACOSX_DEPLOYMENT_TARGET = 10.14;
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = "com.sakuga-software.fruitback.Extension";
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = "com.sakuga-software.Fruitback";
`;

/** The lines of `project.xcproj` that the converter of Xcode 27.2 wrote on 2026-11-24, in the same shape. */
const CONVERTED_27 = `
        "MARKETING_VERSION": "1.0",
        "PRODUCT_BUNDLE_IDENTIFIER": "com.sakuga-software.Fruitback",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "MARKETING_VERSION": "1.0",
        "PRODUCT_BUNDLE_IDENTIFIER": "com.sakuga-software.fruitback.Extension",
    "MACOSX_DEPLOYMENT_TARGET": "27.2",
`;

describe('the Xcode project of Safari, in the form of Xcode 27 (FRU-668)', () => {
  it('makes the same three corrections in `project.xcproj`', () => {
    const fixed = fixXcodeProject(CONVERTED_27, SAFARI_BUNDLE_ID, '0.4.0');

    assert.match(fixed, /"PRODUCT_BUNDLE_IDENTIFIER": "com\.sakuga-software\.fruitback",/);
    assert.match(fixed, /"PRODUCT_BUNDLE_IDENTIFIER": "com\.sakuga-software\.fruitback\.Extension",/);
    assert.doesNotMatch(fixed, /Fruitback"/);
    assert.equal([...fixed.matchAll(/"MARKETING_VERSION": "0\.4\.0"/g)].length, 2);
    assert.equal([...fixed.matchAll(/"MACOSX_DEPLOYMENT_TARGET": "12\.0"/g)].length, 2);
  });

  it('reads the file of the project the converter wrote, and says when there is none', () => {
    const only = (path: string) => (name: string) => name === path;

    assert.equal(projectFileOf('p', only('p/project.pbxproj')), 'p/project.pbxproj');
    assert.equal(projectFileOf('p', only('p/project.xcproj')), 'p/project.xcproj');
    assert.throws(() => projectFileOf('p', () => false), /neither project\.pbxproj nor project\.xcproj/);
  });
});

describe('the Xcode project of Safari (FRU-380)', () => {
  it('prefixes the id of the extension with the id of the app, which xcodebuild requires', () => {
    const fixed = fixXcodeProject(CONVERTED, SAFARI_BUNDLE_ID, '0.4.0');

    assert.match(fixed, /PRODUCT_BUNDLE_IDENTIFIER = "com\.sakuga-software\.fruitback";/);
    assert.match(fixed, /PRODUCT_BUNDLE_IDENTIFIER = "com\.sakuga-software\.fruitback\.Extension";/);
    assert.doesNotMatch(fixed, /Fruitback"/);
  });

  it('gives the app the version of the extension', () => {
    const fixed = fixXcodeProject(CONVERTED, SAFARI_BUNDLE_ID, '0.4.0');

    assert.equal([...fixed.matchAll(/MARKETING_VERSION = 0\.4\.0;/g)].length, 2);
    assert.doesNotMatch(fixed, /MARKETING_VERSION = 1\.0;/);
  });

  it('asks for the oldest macOS the current Xcode builds for, not the macOS of the Mac that converted it', () => {
    const fixed = fixXcodeProject(CONVERTED, SAFARI_BUNDLE_ID, '0.4.0');

    assert.equal(SAFARI_MACOS_MIN, '12.0');
    assert.equal([...fixed.matchAll(/MACOSX_DEPLOYMENT_TARGET = 12\.0;/g)].length, 2);
  });

  it('refuses a version Xcode would not take', () => {
    assert.throws(() => fixXcodeProject(CONVERTED, SAFARI_BUNDLE_ID, '0.4.0-beta'), /not a version/);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SAFARI_BUNDLE_ID, SAFARI_MACOS_MIN, fixXcodeProject } from './safari-xcode.ts';

/** The lines of the project the converter of Xcode 26.6 wrote on 2026-10-28, in the same shape. */
const CONVERTED = `
				MACOSX_DEPLOYMENT_TARGET = 26.5;
				MACOSX_DEPLOYMENT_TARGET = 10.14;
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = "com.sakuga-software.fruitback.Extension";
				MARKETING_VERSION = 1.0;
				PRODUCT_BUNDLE_IDENTIFIER = "com.sakuga-software.Fruitback";
`;

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

  it('asks for the oldest macOS with Safari 16.4, not the macOS of the Mac that converted it', () => {
    const fixed = fixXcodeProject(CONVERTED, SAFARI_BUNDLE_ID, '0.4.0');

    assert.equal(SAFARI_MACOS_MIN, '11.0');
    assert.equal([...fixed.matchAll(/MACOSX_DEPLOYMENT_TARGET = 11\.0;/g)].length, 2);
  });

  it('refuses a version Xcode would not take', () => {
    assert.throws(() => fixXcodeProject(CONVERTED, SAFARI_BUNDLE_ID, '0.4.0-beta'), /not a version/);
  });
});

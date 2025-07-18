// Copyright 2023 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {createHash} from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {GEN_DIR, SOURCE_ROOT} from './paths';

export type ArtifactGroup = Record<string, {
  filePath: string,
}>;

export class ScreenshotError extends Error {
  // The max length of the summary is 4000, but we need to leave some room for
  // the rest of the HTML formatting (e.g. <pre> and </pre>).
  static readonly SUMMARY_LENGTH_CUTOFF = 3900;
  static errors: ScreenshotError[] = [];
  readonly screenshots: ArtifactGroup;
  screenshotPath?: string;

  private constructor(screenshots: ArtifactGroup, message?: string, cause?: Error, screenshotPath?: string) {
    message = [message, cause?.message, (cause?.cause as Error)?.message].filter(x => x).join('\n\n');
    super(message);
    this.cause = cause;
    this.stack = cause?.stack ?? '';
    this.screenshots = screenshots;

    // To show Diffs mocha Spec reporter expects some properties.
    // See node_modules/mocha/lib/reporters/base.js.
    // @ts-expect-error forwarding error properties for Mocha.
    this.showDiff = cause?.showDiff;
    // @ts-expect-error forwarding error properties for Mocha.
    this.actual = cause?.actual;
    // @ts-expect-error forwarding error properties for Mocha.
    this.expected = cause?.expected;
    // @ts-expect-error forwarding error properties for Mocha.
    this.operator = cause?.operator;
    this.screenshotPath = screenshotPath;
  }

  /**
   * Creates a ScreenshotError when a reference golden does not exists.
   */
  static fromGeneratedScreenshot(message: string, generatedImgPath: string) {
    const screenshots = {
      generated: {filePath: this.stashArtifact(generatedImgPath, 'generated')},
    };
    const screenshotPath =
        path.join('test/goldens', path.relative(path.join(GEN_DIR, 'test/.generated'), generatedImgPath));
    return new ScreenshotError(screenshots, message, undefined, screenshotPath);
  }

  /**
   * Creates a ScreenshotError when a generated screenshot is different from
   * the golden.
   */
  static fromScreenshotAssertionError(
      error: Error, goldenImgPath: string, generatedImgPath: string, diffImgPath: string) {
    const screenshots = {
      expected_image: {filePath: this.stashArtifact(goldenImgPath, 'expected')},
      actual_image: {filePath: this.stashArtifact(generatedImgPath, 'actual')},
      image_diff: {filePath: this.stashArtifact(diffImgPath, 'diff')},
    };
    const screenshotPath = path.relative(SOURCE_ROOT, goldenImgPath);
    return new ScreenshotError(screenshots, undefined, error, screenshotPath);
  }

  /**
   * Creates a ScreenshotError when an unexpected error occurs. Screenshots are
   * taken for both the inspected page and the DevTools page.
   */
  static fromBase64Images(error: Error, inspectedPageScreenshot?: string, devToolsPageScreenshot?: string) {
    if (!inspectedPageScreenshot || !devToolsPageScreenshot) {
      console.error('No artifacts to save.');
      return error;
    }
    const screenshots = {
      inspectedPage: {filePath: this.saveArtifact(inspectedPageScreenshot)},
      devToolsPage: {filePath: this.saveArtifact(devToolsPageScreenshot)},
    };
    return new ScreenshotError(screenshots, undefined, error);
  }

  /**
   * Costructs a summary for Milo at resultdb publication time.
   */
  toMiloSummary(): string {
    let summary: string;
    if ('expected_image' in this.screenshots) {
      // no summary; autogenerated by Milo based on artifact name convention
      summary = '';
    } else if ('generated' in this.screenshots) {
      // TODO(liviurau): embed image once Milo supports it
      summary = '<pre>' + this.message.slice(0, ScreenshotError.SUMMARY_LENGTH_CUTOFF) +
          '</pre><p>Screenshot generated (see below)</p>';
    } else {
      // TODO(liviurau): embed images once Milo supports it
      const message = (this.message + '\n\n' + this.stack).slice(0, ScreenshotError.SUMMARY_LENGTH_CUTOFF);
      summary =
          '<pre>' + message + '</pre><p>Unexpected error. See inspected and DevTools pages screenshots below.</p>';
    }
    return summary;
  }

  /**
   * Copy artifacts in tmp folder so they remain available
   * at resultdb publication time.
   */
  private static stashArtifact(originalFile: string, tag: string): string {
    const stashedFileName = tag + '-' + path.basename(originalFile);
    const artifactPath = path.join(os.tmpdir(), stashedFileName);
    fs.copyFileSync(originalFile, artifactPath);
    return artifactPath;
  }

  /**
   * Save base64 image in tmp folder to make it available at resultdb
   * publication time.
   */
  private static saveArtifact(base64Image: string): string {
    base64Image = base64Image.replace(/^data:image\/png;base64,/, '');
    const fileName = createHash('sha256').update(base64Image).digest('hex');
    const artifactPath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(artifactPath, base64Image, {encoding: 'base64'});
    return artifactPath;
  }
}

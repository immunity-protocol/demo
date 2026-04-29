#!/usr/bin/env node
/**
 * Postinstall patch for @0glabs/0g-serving-broker 0.7.5.
 *
 * The package ships its ESM build under lib.esm/ but doesn't declare
 * "type": "module" anywhere — neither at the package root nor as a
 * nested package.json in lib.esm/. Result: Node's ESM resolver treats
 * lib.esm/*.js as CommonJS (the default for .js without "type":"module"),
 * which breaks on Node >= 24/25 with errors like:
 *
 *   SyntaxError: The requested module './index-33b65b9f.js' does not
 *   provide an export named 'C'
 *
 * The fix is a one-liner: drop a `{"type":"module"}` package.json into
 * lib.esm/ so Node resolves .js files there as ESM. Idempotent — re-runs
 * are no-ops.
 *
 * Remove this once upstream ships a fix (track:
 * https://github.com/0glabs/0g-serving-broker).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const target = "node_modules/@0glabs/0g-serving-broker/lib.esm/package.json";
const content = `{"type":"module"}\n`;

try {
  if (!existsSync(dirname(target))) {
    // Package not installed (postinstall ran before the dep was actually
    // added — which can happen with workspace bootstraps). Nothing to do.
    process.exit(0);
  }
  writeFileSync(target, content);
  // Quiet on success: postinstall hooks run on every npm install and
  // should not flood the log unless something went wrong.
} catch (err) {
  // Don't fail the install over a postinstall hiccup; just log it.
  console.warn(`[patch-0g-broker] could not patch lib.esm: ${err?.message ?? err}`);
}

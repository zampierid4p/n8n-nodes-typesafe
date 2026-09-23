#!/usr/bin/env node
/**
 * Runs the rules n8n's community scanner gates on, against the sources in this repo.
 *
 * The scanner itself only accepts a package that is already on npm, so without this the
 * first time a violation appears is after publishing — which is how v0.3.0 shipped with
 * eight of them. `n8n-node lint` is not a substitute: it builds a different config and
 * reported nothing at all for that same commit.
 *
 * Reusing the scanner's own analyzePackage and file patterns keeps this from drifting
 * away from what the real gate checks.
 */
import { analyzePackage, SOURCE_FILE_PATTERNS } from '@n8n/scan-community-package/scanner/scanner.mjs';

const result = await analyzePackage(process.cwd(), SOURCE_FILE_PATTERNS);

if (result.passed) {
	console.log('n8n community scan rules: no violations');
	process.exit(0);
}

console.error(`n8n community scan rules: ${result.message}`);
if (result.details) console.error(result.details);
process.exit(1);

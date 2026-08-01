#!/usr/bin/env node
/**
 * Product loop for review-guidance-doc-contract (F36).
 *
 * Status line (exact prefix): `DOC-CONTRACT phrases=`
 */
import { runDocContract } from '../../packages/cli/src/review-guidance-contract.mjs';

const { phrases, self } = runDocContract();
process.stdout.write(`DOC-CONTRACT phrases=${phrases.length} self=${self}\n`);

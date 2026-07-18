import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LENSES,
  SCOPE_TYPES,
  SEVERITIES,
  ALL_VERDICTS,
  CONFIDENCES,
  STATS_KEYS,
} from './lib.mjs';

/**
 * The agent-facing JSON Schema and the runtime validator in lib.mjs describe the
 * same contract. They live in different trees (the skill vs. scripts/), so this
 * test fails loudly if their enums ever drift apart.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'skills',
  'thorough-code-review',
  'reference',
  'report-schema.json',
);
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

const runtimeSchemaPath = path.join(__dirname, 'schema.json');
const runtimeSchema = JSON.parse(fs.readFileSync(runtimeSchemaPath, 'utf8'));

const sorted = (arr) => [...arr].sort();

test('schema file exists and parses', () => {
  assert.ok(schema && typeof schema === 'object');
});

test('lens enum matches lib.LENSES', () => {
  assert.deepEqual(sorted(schema.properties.lenses.items.enum), sorted(LENSES));
});

test('scope.type enum matches lib.SCOPE_TYPES', () => {
  assert.deepEqual(sorted(schema.properties.scope.properties.type.enum), sorted(SCOPE_TYPES));
});

test('finding.severity enum matches lib.SEVERITIES', () => {
  assert.deepEqual(sorted(schema.$defs.finding.properties.severity.enum), sorted(SEVERITIES));
});

test('finding.verdict enum matches lib.ALL_VERDICTS', () => {
  assert.deepEqual(sorted(schema.$defs.finding.properties.verdict.enum), sorted(ALL_VERDICTS));
});

test('finding.phase1_confidence enum matches lib.CONFIDENCES', () => {
  assert.deepEqual(
    sorted(schema.$defs.finding.properties.phase1_confidence.enum),
    sorted(CONFIDENCES),
  );
});

test('second_opinion verdict enum matches lib.ALL_VERDICTS', () => {
  assert.deepEqual(
    sorted(schema.$defs.finding.properties.second_opinion.properties.verdict.enum),
    sorted(ALL_VERDICTS),
  );
});

test('stats keys match lib.STATS_KEYS', () => {
  assert.deepEqual(sorted(Object.keys(schema.properties.stats.properties)), sorted(STATS_KEYS));
});

test('runtime schema.json shares top-level property names with the reference schema', () => {
  assert.deepEqual(
    sorted(Object.keys(runtimeSchema.properties)),
    sorted(Object.keys(schema.properties)),
  );
});

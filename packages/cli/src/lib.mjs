#!/usr/bin/env node
/**
 * Shared helpers for Forge session management.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { registerSession } from './lib/fleet.mjs';

export const REPO_ROOT = process.cwd();
export const FORGE_DIR = path.join(REPO_ROOT, '.forge');
export const SESSIONS_DIR = path.join(FORGE_DIR, 'sessions');
export const ACTIVE_FILE = path.join(FORGE_DIR, 'active.json');
export const RETENTION_DAYS = 14;

export function ensureForgeLayout() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function slugify(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';
}

export function utcCompactNow() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function randomSuffix(bytes = 3) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function makeSessionId(slug) {
  return `${utcCompactNow()}-${slugify(slug)}-${randomSuffix()}`;
}

export function sessionPath(sessionId) {
  return path.join(SESSIONS_DIR, sessionId);
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function readActive() {
  if (!fs.existsSync(ACTIVE_FILE)) return null;
  try {
    return readJson(ACTIVE_FILE);
  } catch {
    return null;
  }
}

export function writeActive(sessionId) {
  writeJson(ACTIVE_FILE, {
    sessionId,
    sessionPath: path.relative(REPO_ROOT, sessionPath(sessionId)).replace(/\\/g, '/'),
    updatedAt: new Date().toISOString(),
  });
}

export function clearActive() {
  if (fs.existsSync(ACTIVE_FILE)) fs.unlinkSync(ACTIVE_FILE);
}

export function defaultSession(sessionId, slug) {
  const now = new Date().toISOString();
  return {
    id: sessionId,
    slug: slugify(slug),
    createdAt: now,
    updatedAt: now,
    phase: 'triage',
    planType: null,
    openspecChange: null,
    forgeSkipped: false,
    cursorChatId: null,
    tasksTotal: 0,
    tasksComplete: 0,
    /** Requested pace: auto | thorough | standard | brisk | lite */
    pace: 'auto',
    /** Concrete pace after auto resolve or explicit pin */
    resolvedPace: null,
    paceReason: null,
    paceSignal: null,
    pacePinned: false,
    preferencesOverride: null,
  };
}

export function defaultStatus(session) {
  return {
    sessionId: session.id,
    phase: session.phase,
    planType: session.planType,
    openspecChange: session.openspecChange,
    tasksTotal: session.tasksTotal,
    tasksComplete: session.tasksComplete,
    pace: session.pace ?? null,
    resolvedPace: session.resolvedPace ?? null,
    paceReason: session.paceReason ?? null,
    updatedAt: session.updatedAt,
  };
}

export function scaffoldSessionDirs(dir) {
  for (const sub of ['brainstorm', 'tasks', 'reviews']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
}

export function loadSession(sessionId) {
  const dir = sessionPath(sessionId);
  const file = path.join(dir, 'session.json');
  if (!fs.existsSync(file)) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return { dir, session: readJson(file) };
}

export function saveSession(dir, session) {
  session.updatedAt = new Date().toISOString();
  writeJson(path.join(dir, 'session.json'), session);
  writeJson(path.join(dir, 'status.json'), defaultStatus(session));
  // Mirror into ~/.forgekit/fleet so `forge fleet` sees every project's
  // sessions. Project root derived from dir (<root>/.forge/sessions/<id>),
  // not REPO_ROOT, so callers with explicit dirs mirror correctly too.
  registerSession(path.resolve(dir, '..', '..', '..'), session);
}

export function sessionAgeDays(session) {
  const created = new Date(session.createdAt).getTime();
  return (Date.now() - created) / (1000 * 60 * 60 * 24);
}

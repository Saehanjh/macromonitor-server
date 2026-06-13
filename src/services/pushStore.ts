import fs from 'fs';
import path from 'path';
import { config } from '../config';

// Simple file-persisted store of Expo push tokens + last-fired alert state.
// In production swap for a real DB; JSON file keeps the demo dependency-free.

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ── push tokens ────────────────────────────────────────────────────────
const TOKEN_PATH = config.push.tokenStorePath;
let tokens = new Set<string>(readJson<string[]>(TOKEN_PATH, []));

export function addToken(token: string): void {
  if (!token || !token.startsWith('ExponentPushToken')) return;
  if (!tokens.has(token)) {
    tokens.add(token);
    writeJson(TOKEN_PATH, [...tokens]);
  }
}

export function removeToken(token: string): void {
  if (tokens.delete(token)) writeJson(TOKEN_PATH, [...tokens]);
}

export function listTokens(): string[] {
  return [...tokens];
}

// ── alert edge-trigger state (alertId → wasActive) ─────────────────────
const STATE_PATH = config.push.alertStatePath;
type AlertState = Record<string, { active: boolean; firedAt: number | null }>;
let alertState: AlertState = readJson<AlertState>(STATE_PATH, {});

export function getAlertActive(id: string): boolean {
  return alertState[id]?.active ?? false;
}

export function setAlertActive(id: string, active: boolean): void {
  const prev = alertState[id];
  alertState[id] = {
    active,
    firedAt: active && !(prev?.active) ? Date.now() : prev?.firedAt ?? null,
  };
  writeJson(STATE_PATH, alertState);
}

export function snapshotAlertState(): AlertState {
  return { ...alertState };
}

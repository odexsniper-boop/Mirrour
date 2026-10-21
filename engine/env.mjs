/**
 * Minimal .env loader (the project has zero dependencies).
 * Reads KEY=VALUE lines from a file and sets them on process.env without
 * overriding variables that are already set in the real environment.
 */
import fs from 'node:fs';

export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

export function loadEnvFile(filePath, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { loaded: false, keys: [] };
  }
  const parsed = parseEnv(text);
  const keys = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined || env[k] === '') {
      env[k] = v;
      keys.push(k);
    }
  }
  return { loaded: true, keys };
}

/** Show only the start and end of a secret, e.g. "alch_M1…nf". */
export function maskSecret(secret) {
  const s = String(secret || '');
  if (!s) return '';
  if (s.length <= 10) return `${s.slice(0, 2)}…`;
  return `${s.slice(0, 7)}…${s.slice(-2)}`;
}

/** Replace any occurrence of the secret inside a string (URLs, errors) with its masked form. */
export function redact(text, secret) {
  if (!secret) return String(text ?? '');
  return String(text ?? '').split(secret).join(maskSecret(secret));
}

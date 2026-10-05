'use strict';

// @intent Read AWS keys from env, then ~/.aws/credentials; stdout is a JSON object
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_ID = 'AWS_ACCESS_KEY_ID';
const SECRET = 'AWS_SECRET_ACCESS_KEY';

function envValue(name) {
  const direct = process.env[name];
  if (direct && String(direct).trim()) return String(direct).trim();
  const prefixed = process.env[`SECRET__${name}`];
  if (prefixed && String(prefixed).trim()) return String(prefixed).trim();
  return '';
}

function parseCredentialsIni(text, profile) {
  const lines = String(text).split(/\r?\n/);
  let current = '';
  const sections = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const section = trimmed.match(/^\[(.+)]$/);
    if (section) {
      current = section[1].trim();
      if (!sections[current]) sections[current] = {};
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0 || !current) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    const value = trimmed.slice(eq + 1).trim();
    sections[current][key] = value;
  }
  const block = sections[profile] || {};
  return {
    [KEY_ID]: block.aws_access_key_id || '',
    [SECRET]: block.aws_secret_access_key || '',
  };
}

function fromCredentialsFile() {
  const profile = process.env.AWS_PROFILE || 'default';
  const credPath =
    process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');
  try {
    const text = fs.readFileSync(credPath, 'utf8');
    return parseCredentialsIni(text, profile);
  } catch {
    return { [KEY_ID]: '', [SECRET]: '' };
  }
}

const fromFile = fromCredentialsFile();
const out = {};
const id = envValue(KEY_ID) || fromFile[KEY_ID];
const secret = envValue(SECRET) || fromFile[SECRET];
if (id) out[KEY_ID] = id;
if (secret) out[SECRET] = secret;
process.stdout.write(JSON.stringify(out));




// Minimal structured logger: one JSON line per entry on stdout/stderr.
// Values under secret-looking keys are always redacted.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
// Matches apiToken / accessToken / token, but not counters like inputTokens.
const SECRET_KEY = /token$|secret|password|passwd|api[_-]?key|authorization|cookie|credential|webhook/i;

let threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

export function setLogLevel(level) {
  if (!(level in LEVELS)) throw new Error(`Unknown log level "${level}"`);
  threshold = LEVELS[level];
}

export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) && v ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function write(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const entry = { ts: new Date().toISOString(), level, msg, ...redact(fields ?? {}) };
  const line = JSON.stringify(entry) + '\n';
  (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(line);
}

function make(bindings = {}) {
  const log = (level) => (msg, fields) => write(level, msg, { ...bindings, ...fields });
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (extra) => make({ ...bindings, ...extra }),
  };
}

export const logger = make();

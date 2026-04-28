/**
 * Tiny JSON-line logger. Each line is a self-contained record so docker logs +
 * loki/cloudwatch can parse without a multi-line setup.
 *
 * Bound loggers carry agent context (id, role, display name) so individual
 * call-sites don't have to repeat themselves.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function envLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVEL_RANK[raw] ?? LEVEL_RANK.info;
}

const threshold = envLevel();

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(extra: Record<string, unknown>): Logger;
}

function emit(level: LogLevel, base: Record<string, unknown>, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < threshold) {
    return;
  }
  const record = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...base,
    ...(fields ?? {}),
  };
  // Errors go to stderr so docker keeps the stream classification right.
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

function build(base: Record<string, unknown>): Logger {
  return {
    debug: (m, f) => emit("debug", base, m, f),
    info:  (m, f) => emit("info",  base, m, f),
    warn:  (m, f) => emit("warn",  base, m, f),
    error: (m, f) => emit("error", base, m, f),
    child: (extra) => build({ ...base, ...extra }),
  };
}

export function createLogger(initial: Record<string, unknown> = {}): Logger {
  return build(initial);
}

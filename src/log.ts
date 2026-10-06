/**
 * Minimal structured logger: one JSON object per line on stdout. Callers pass
 * context as fields. Secret *values* (the Gitea token, Claude credentials) are
 * replaced with "[redacted]" wherever they appear in a line, including inside
 * error messages, so a token that leaks into an exception never reaches logs.
 */

export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type Level = (typeof LEVELS)[number];

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

/** The process's root logger, whose threshold can change at runtime (LOG_LEVEL from the dashboard). */
export interface RootLogger extends Logger {
  setLevel(level: Level): void;
}

export interface LoggerOptions {
  write?: (line: string) => void;
  /** Also receives every line, after redaction (the dashboard's log view). */
  sink?: (line: string) => void;
  /** Values to redact. Very short values are ignored to avoid mangling logs. */
  secrets?: readonly (string | undefined)[];
}

const MIN_SECRET_LENGTH = 8;

export function createLogger(level: Level, options: LoggerOptions = {}): RootLogger {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const sink = options.sink;
  const secrets = (options.secrets ?? []).filter(
    (secret): secret is string => secret !== undefined && secret.length >= MIN_SECRET_LENGTH,
  );
  const redact = (line: string) =>
    secrets.reduce((out, secret) => out.replaceAll(secret, "[redacted]"), line);
  // Shared by every child, so setLevel reaches loggers handed out earlier.
  const threshold = { value: LEVELS.indexOf(level) };
  const root = logger(
    threshold,
    (line) => {
      const safe = redact(line);
      write(safe);
      sink?.(safe);
    },
    {},
  );
  return {
    ...root,
    setLevel: (next) => {
      threshold.value = LEVELS.indexOf(next);
    },
  };
}

function logger(
  threshold: { value: number },
  write: (line: string) => void,
  bound: Fields,
): Logger {
  const emit = (at: Level, message: string, fields: Fields = {}) => {
    if (LEVELS.indexOf(at) < threshold.value) return;
    write(
      JSON.stringify(
        { time: new Date().toISOString(), level: at, msg: message, ...bound, ...fields },
        errorReplacer,
      ),
    );
  };
  return {
    debug: (message, fields) => {
      emit("debug", message, fields);
    },
    info: (message, fields) => {
      emit("info", message, fields);
    },
    warn: (message, fields) => {
      emit("warn", message, fields);
    },
    error: (message, fields) => {
      emit("error", message, fields);
    },
    child: (fields) => logger(threshold, write, { ...bound, ...fields }),
  };
}

/** A logger that drops everything (tests). */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

/**
 * The last `capacity` log lines, kept in memory for the dashboard. Lines
 * arrive already redacted (see `sink`), so nothing here can leak a secret.
 */
export class LogBuffer {
  private readonly lines: string[] = [];
  private readonly listeners = new Set<(line: string) => void>();

  constructor(private readonly capacity = 1000) {}

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    for (const listener of this.listeners) listener(line);
  }

  /** Oldest first. */
  recent(limit = this.capacity): string[] {
    return this.lines.slice(-limit);
  }

  /** Call `listener` with each new line; returns the unsubscribe function. */
  subscribe(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}

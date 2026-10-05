/**
 * Minimal structured logger: one JSON object per line on stdout. Callers pass
 * context as fields; nothing here knows about secrets, so never log tokens
 * (log `redactConfig(config)` instead of the config itself).
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

export function createLogger(
  level: Level,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  bound: Fields = {},
): Logger {
  const threshold = LEVELS.indexOf(level);
  const emit = (at: Level, message: string, fields: Fields = {}) => {
    if (LEVELS.indexOf(at) < threshold) return;
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
    child: (fields) => createLogger(level, write, { ...bound, ...fields }),
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

function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}

/**
 * Accumulates what the dispatcher needs from `claude -p --output-format
 * stream-json --verbose`: one JSON object per line. Shapes verified against
 * Claude Code 2.1.289:
 *
 * - `{"type":"system","subtype":"init","session_id":…}` starts the stream.
 * - `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"|
 *   "allowed_warning"|"rejected","resetsAt":<epoch seconds>,"rateLimitType":
 *   "five_hour"|"seven_day"|…,"utilization":<0..1>}}` whenever limits change.
 * - `{"type":"result","subtype":"success"|"error_max_turns"|
 *   "error_max_budget_usd"|"error_during_execution"|
 *   "error_max_structured_output_retries","is_error":…,"structured_output":…,
 *   "total_cost_usd":…,"usage":{…},"errors":[…]}` ends it.
 *
 * Everything else (assistant/user messages, tool progress) is ignored.
 * Unparseable lines are counted, not fatal: a run is judged by its result.
 */

export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: Date;
  type?: string;
  utilization?: number;
}

export interface ResultMessage {
  subtype: string;
  isError: boolean;
  structuredOutput?: unknown;
  resultText?: string;
  errors: string[];
  numTurns?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface StreamState {
  sessionId?: string;
  /** The most recent rate-limit info seen. */
  rateLimit?: RateLimitInfo;
  result?: ResultMessage;
  malformedLines: number;
}

export function emptyStreamState(): StreamState {
  return { malformedLines: 0 };
}

export function applyStreamLine(state: StreamState, line: string): void {
  if (line.trim() === "") return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    state.malformedLines++;
    return;
  }
  if (!isRecord(message)) {
    state.malformedLines++;
    return;
  }

  const sessionId = message.session_id;
  if (typeof sessionId === "string" && sessionId !== "") state.sessionId = sessionId;

  if (message.type === "rate_limit_event" && isRecord(message.rate_limit_info)) {
    const info = parseRateLimit(message.rate_limit_info);
    if (info) state.rateLimit = info;
  } else if (message.type === "result") {
    state.result = parseResult(message);
  }
}

function parseRateLimit(info: Record<string, unknown>): RateLimitInfo | undefined {
  const { status, resetsAt, rateLimitType, utilization } = info;
  if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") {
    return undefined;
  }
  return {
    status,
    ...(typeof resetsAt === "number" ? { resetsAt: epochToDate(resetsAt) } : {}),
    ...(typeof rateLimitType === "string" ? { type: rateLimitType } : {}),
    ...(typeof utilization === "number" ? { utilization } : {}),
  };
}

function parseResult(message: Record<string, unknown>): ResultMessage {
  const usage = isRecord(message.usage) ? message.usage : {};
  const inputTokens = sumNumbers(
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  );
  return {
    subtype: typeof message.subtype === "string" ? message.subtype : "unknown",
    isError: message.is_error === true,
    ...(message.structured_output != null ? { structuredOutput: message.structured_output } : {}),
    ...(typeof message.result === "string" ? { resultText: message.result } : {}),
    errors: Array.isArray(message.errors)
      ? message.errors.filter((e): e is string => typeof e === "string")
      : [],
    ...(typeof message.num_turns === "number" ? { numTurns: message.num_turns } : {}),
    ...(typeof message.total_cost_usd === "number" ? { costUsd: message.total_cost_usd } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
  };
}

/** The CLI reports epoch seconds; tolerate milliseconds in case that changes. */
function epochToDate(value: number): Date {
  return new Date(value > 1e12 ? value : value * 1000);
}

function sumNumbers(...values: unknown[]): number | undefined {
  const numbers = values.filter((v): v is number => typeof v === "number");
  return numbers.length === 0 ? undefined : numbers.reduce((a, b) => a + b, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

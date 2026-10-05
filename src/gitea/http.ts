/**
 * Transport for the Gitea REST API: auth, JSON, timeouts, retries and
 * pagination. Kept separate from the endpoint methods so retry policy can be
 * tested once instead of per endpoint.
 *
 * Retry policy: idempotent methods retry on network errors, 429 and 5xx.
 * POST only retries on 429 and 503, where the server signals it did not do the
 * work; retrying a POST after an ambiguous failure could file a duplicate issue
 * or comment.
 */

export class GiteaError extends Error {
  override name = "GiteaError";

  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number | undefined,
    readonly detail: string,
  ) {
    super(
      `${method} ${path} failed${status === undefined ? "" : ` (${String(status)})`}: ${detail}`,
    );
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof GiteaError && error.status === 404;
}

export interface HttpOptions {
  /** Instance root, e.g. https://gitea.example.com (no /api/v1). */
  baseUrl: string;
  token: string;
  userAgent?: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Return the body as text instead of parsing JSON (e.g. job logs). */
  text?: boolean;
}

const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "PATCH", "DELETE"]);
const MAX_PAGE_SIZE = 50;

export class GiteaHttp {
  private readonly apiRoot: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;

  constructor(private readonly options: HttpOptions) {
    this.apiRoot = `${options.baseUrl.replace(/\/+$/, "")}/api/v1`;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 500;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const { response } = await this.send(method, path, options);
    return (await this.parse(response, options)) as T;
  }

  /**
   * Fetch every page of a list endpoint. Stops at X-Total-Count when the server
   * sends it, otherwise at the first short or empty page.
   */
  async paginate<T>(path: string, query: Query = {}): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const { response } = await this.send("GET", path, {
        query: { ...query, page, limit: MAX_PAGE_SIZE },
      });
      const batch = (await this.parse(response, {})) as T[];
      items.push(...batch);
      const total = Number(response.headers.get("x-total-count") ?? Number.NaN);
      const done = Number.isFinite(total) ? items.length >= total : batch.length < MAX_PAGE_SIZE;
      if (done || batch.length === 0) return items;
    }
  }

  private async send(
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<{ response: Response }> {
    const url = this.url(path, options.query);
    const headers: Record<string, string> = {
      Authorization: `token ${this.options.token}`,
      Accept: options.text === true ? "text/plain" : "application/json",
      "User-Agent": this.options.userAgent ?? "claude-dispatcher",
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (IDEMPOTENT.has(method) && attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new GiteaError(method, path, undefined, detail);
      }

      if (response.ok) return { response };
      if (attempt < this.maxRetries && this.retryable(method, response.status)) {
        await this.sleep(this.retryAfter(response) ?? this.backoff(attempt));
        continue;
      }
      throw new GiteaError(method, path, response.status, await errorDetail(response));
    }
  }

  private url(path: string, query: Query = {}): string {
    const url = new URL(this.apiRoot + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async parse(response: Response, options: RequestOptions): Promise<unknown> {
    const text = await response.text();
    if (options.text === true) return text;
    return text === "" ? undefined : (JSON.parse(text) as unknown);
  }

  private retryable(method: string, status: number): boolean {
    if (status === 429 || status === 503) return true;
    return IDEMPOTENT.has(method) && status >= 500;
  }

  private backoff(attempt: number): number {
    const exponential = this.baseDelayMs * 2 ** attempt;
    return exponential + Math.random() * this.baseDelayMs;
  }

  private retryAfter(response: Response): number | undefined {
    const seconds = Number(response.headers.get("retry-after"));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
  }
}

/**
 * Build an API path, URL-encoding each interpolated value so branch names
 * with slashes or odd characters can't change the route.
 */
export function apiPath(strings: TemplateStringsArray, ...values: (string | number)[]): string {
  return strings.reduce(
    (out, part, i) => out + part + (i < values.length ? encodeURIComponent(String(values[i])) : ""),
    "",
  );
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON (e.g. an HTML error page from a proxy); fall through to raw text.
  }
  return text.slice(0, 200) || response.statusText;
}

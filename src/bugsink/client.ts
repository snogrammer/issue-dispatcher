import { apiPath as p } from "../gitea/http.js";

/**
 * The few Bugsink API calls the dispatcher makes (canonical API v0, Bugsink
 * 2.6+): resolve, mute and comment on an issue, and read its latest
 * stacktrace for the Gitea issue body. No retries: the intake and the resolve
 * sweep decide what a failure means (a resolve is retried next poll).
 */

export class BugsinkError extends Error {
  override name = "BugsinkError";

  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number | undefined,
    readonly detail: string,
  ) {
    super(
      `Bugsink ${method} ${path} failed${status === undefined ? "" : ` (${String(status)})`}: ${detail}`,
    );
  }
}

export interface BugsinkOptions {
  /** Instance root, e.g. https://bugsink.example.com. */
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface EventList {
  results: { id: string }[];
}

export class BugsinkClient {
  private readonly apiRoot: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: BugsinkOptions) {
    this.apiRoot = `${options.baseUrl.replace(/\/+$/, "")}/api/canonical/0`;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async resolve(issueId: string): Promise<void> {
    await this.send("POST", p`/issues/${issueId}/resolve/`);
  }

  async mute(issueId: string): Promise<void> {
    await this.send("POST", p`/issues/${issueId}/mute/`);
  }

  async comment(issueId: string, comment: string): Promise<void> {
    await this.send("POST", "/issue-comments/", { issue: issueId, comment });
  }

  /** The newest event's stacktrace as Markdown, or undefined if the issue has no events. */
  async latestStacktrace(issueId: string): Promise<string | undefined> {
    const events = JSON.parse(
      await this.send(
        "GET",
        `/events/?${new URLSearchParams({ issue: issueId, order: "desc" }).toString()}`,
      ),
    ) as EventList;
    const latest = events.results[0];
    if (latest === undefined) return undefined;
    return this.send("GET", p`/events/${latest.id}/stacktrace/`);
  }

  private async send(method: string, path: string, body?: unknown): Promise<string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
      "User-Agent": "claude-dispatcher",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(this.apiRoot + path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new BugsinkError(
        method,
        path,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
    const text = await response.text();
    if (!response.ok) {
      throw new BugsinkError(
        method,
        path,
        response.status,
        text.slice(0, 200) || response.statusText,
      );
    }
    return text;
  }
}

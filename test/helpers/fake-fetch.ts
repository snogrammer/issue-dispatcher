/**
 * A scripted stand-in for `fetch` that records each request. Tests queue
 * responses (or errors) in order, or supply a responder for table-driven cases.
 */

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = Response | Error;

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { status: 200, ...init, headers });
}

export function fakeFetch(replies: Reply[] | ((request: RecordedRequest) => Reply)) {
  const requests: RecordedRequest[] = [];
  const queue = Array.isArray(replies) ? [...replies] : undefined;
  const responder = Array.isArray(replies) ? undefined : replies;

  const fetchImpl = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const request: RecordedRequest = {
      method: init.method ?? "GET",
      url: new URL(input instanceof Request ? input.url : input),
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const reply = queue ? queue.shift() : responder?.(request);
    if (reply === undefined)
      throw new Error(`unexpected request ${request.method} ${request.url.href}`);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };

  return { fetch: fetchImpl, requests };
}

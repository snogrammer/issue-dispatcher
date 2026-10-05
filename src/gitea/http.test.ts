import { describe, expect, it, vi } from "vitest";

import { fakeFetch, jsonResponse } from "../../test/helpers/fake-fetch.js";
import { apiPath, GiteaError, GiteaHttp, isNotFound } from "./http.js";

const TOKEN = "super-secret-token";

function http(replies: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(replies);
  const sleep = vi.fn(() => Promise.resolve());
  const client = new GiteaHttp({
    baseUrl: "https://gitea.example.com/",
    token: TOKEN,
    fetch: fake.fetch,
    sleep,
    maxRetries: 2,
  });
  return { client, sleep, requests: fake.requests };
}

async function failure(promise: Promise<unknown>): Promise<GiteaError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GiteaError);
    return error as GiteaError;
  }
  throw new Error("expected request to fail");
}

describe("GiteaHttp.request", () => {
  it("sends auth, user agent and JSON body to the API root", async () => {
    const { client, requests } = http([jsonResponse({ id: 1 })]);
    const result = await client.request("POST", "/repos/o/r/issues", {
      query: { state: "open", skip: undefined },
      body: { title: "t" },
    });
    expect(result).toEqual({ id: 1 });
    const [request] = requests;
    expect(request?.url.href).toBe("https://gitea.example.com/api/v1/repos/o/r/issues?state=open");
    expect(request?.method).toBe("POST");
    expect(request?.headers).toMatchObject({
      Authorization: `token ${TOKEN}`,
      "User-Agent": "claude-dispatcher",
      "Content-Type": "application/json",
    });
    expect(request?.body).toEqual({ title: "t" });
  });

  it("returns undefined for empty bodies and raw text when asked", async () => {
    const { client } = http([new Response(""), new Response("log line\n")]);
    expect(await client.request("POST", "/merge")).toBeUndefined();
    expect(await client.request("GET", "/logs", { text: true })).toBe("log line\n");
  });

  it("retries idempotent requests on 5xx and network errors", async () => {
    const { client, sleep, requests } = http([
      new Response("bad gateway", { status: 502 }),
      new TypeError("fetch failed"),
      jsonResponse({ ok: true }),
    ]);
    expect(await client.request("GET", "/x")).toEqual({ ok: true });
    expect(requests).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries", async () => {
    const { client, requests } = http(() => new Response("down", { status: 500 }));
    const error = await failure(client.request("PATCH", "/x"));
    expect(error.status).toBe(500);
    expect(requests).toHaveLength(3);
  });

  it("does not retry POST after an ambiguous failure", async () => {
    const gateway = http([new Response("", { status: 502 })]);
    expect((await failure(gateway.client.request("POST", "/x"))).status).toBe(502);
    expect(gateway.requests).toHaveLength(1);

    const network = http([new TypeError("socket hang up")]);
    const error = await failure(network.client.request("POST", "/x"));
    expect(error.status).toBeUndefined();
    expect(network.requests).toHaveLength(1);
  });

  it("retries POST on 429, honoring Retry-After", async () => {
    const { client, sleep } = http([
      new Response("", { status: 429, headers: { "retry-after": "2" } }),
      jsonResponse({ id: 7 }),
    ]);
    expect(await client.request("POST", "/x")).toEqual({ id: 7 });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("does not retry 4xx and reports Gitea's message without the token", async () => {
    const { client, requests } = http([
      jsonResponse({ message: "issue not found" }, { status: 404 }),
    ]);
    const error = await failure(client.request("GET", "/repos/o/r/issues/9"));
    expect(requests).toHaveLength(1);
    expect(isNotFound(error)).toBe(true);
    expect(error.message).toBe("GET /repos/o/r/issues/9 failed (404): issue not found");
    expect(error.message).not.toContain(TOKEN);
  });

  it("truncates non-JSON error bodies", async () => {
    const { client } = http([new Response("<html>" + "x".repeat(500), { status: 403 })]);
    const error = await failure(client.request("GET", "/x"));
    expect(error.detail).toHaveLength(200);
  });
});

describe("GiteaHttp.paginate", () => {
  const page = (n: number, start = 0) => Array.from({ length: n }, (_, i) => ({ id: start + i }));

  it("follows X-Total-Count across pages", async () => {
    const { client, requests } = http([
      jsonResponse(page(50), { headers: { "x-total-count": "60" } }),
      jsonResponse(page(10, 50), { headers: { "x-total-count": "60" } }),
    ]);
    const items = await client.paginate<{ id: number }>("/items", { state: "open" });
    expect(items).toHaveLength(60);
    expect(requests.map((r) => r.url.search)).toEqual([
      "?state=open&page=1&limit=50",
      "?state=open&page=2&limit=50",
    ]);
  });

  it("stops at a short page when there is no total header", async () => {
    const { client, requests } = http([jsonResponse(page(50)), jsonResponse(page(3))]);
    expect(await client.paginate("/items")).toHaveLength(53);
    expect(requests).toHaveLength(2);
  });

  it("stops at an empty page even if the total over-reports", async () => {
    const { client } = http([
      jsonResponse(page(50), { headers: { "x-total-count": "80" } }),
      jsonResponse([], { headers: { "x-total-count": "80" } }),
    ]);
    expect(await client.paginate("/items")).toHaveLength(50);
  });
});

describe("apiPath", () => {
  it("encodes interpolated segments", () => {
    expect(apiPath`/repos/${"o"}/${"r"}/commits/${"feature/a b"}/status`).toBe(
      "/repos/o/r/commits/feature%2Fa%20b/status",
    );
  });
});

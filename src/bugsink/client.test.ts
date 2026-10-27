import { describe, expect, it } from "vitest";

import { fakeFetch, jsonResponse } from "../../test/helpers/fake-fetch.js";
import { BugsinkClient, BugsinkError } from "./client.js";

function client(replies: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(replies);
  return {
    ...fake,
    bugsink: new BugsinkClient({
      baseUrl: "https://bugsink.example.com/",
      token: "tok",
      fetch: fake.fetch,
    }),
  };
}

describe("BugsinkClient", () => {
  it("resolves, mutes and comments with the bearer token", async () => {
    const { bugsink, requests } = client([
      jsonResponse({}),
      jsonResponse({}),
      jsonResponse({ id: 1 }, { status: 201 }),
    ]);
    await bugsink.resolve("uuid-1");
    await bugsink.mute("uuid-1");
    await bugsink.comment("uuid-1", "Filed as #3");

    expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /api/canonical/0/issues/uuid-1/resolve/",
      "POST /api/canonical/0/issues/uuid-1/mute/",
      "POST /api/canonical/0/issue-comments/",
    ]);
    expect(requests[0]?.headers.Authorization).toBe("Bearer tok");
    expect(requests[2]?.body).toEqual({ issue: "uuid-1", comment: "Filed as #3" });
  });

  it("reads the newest event's stacktrace", async () => {
    const { bugsink, requests } = client([
      jsonResponse({ results: [{ id: "ev-2" }, { id: "ev-1" }] }),
      new Response("# Error\nboom", { headers: { "content-type": "text/markdown" } }),
    ]);
    expect(await bugsink.latestStacktrace("uuid-1")).toBe("# Error\nboom");
    expect(requests[0]?.url.searchParams.get("issue")).toBe("uuid-1");
    expect(requests[0]?.url.searchParams.get("order")).toBe("desc");
    expect(requests[1]?.url.pathname).toBe("/api/canonical/0/events/ev-2/stacktrace/");
  });

  it("has no stacktrace for an issue without events", async () => {
    const { bugsink } = client([jsonResponse({ results: [] })]);
    expect(await bugsink.latestStacktrace("uuid-1")).toBeUndefined();
  });

  it("names the call and status when Bugsink refuses", async () => {
    const { bugsink } = client([new Response("nope", { status: 403 })]);
    const error = await bugsink.resolve("uuid-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BugsinkError);
    expect((error as BugsinkError).message).toContain("(403): nope");
  });
});

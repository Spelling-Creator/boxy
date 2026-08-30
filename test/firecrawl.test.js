import { describe, test, beforeEach } from "node:test";
import assert from "node:assert";

import { firecrawlApiBase, firecrawlSearch, hasFirecrawl } from "../src/firecrawl.js";
import { fetchUrl } from "../src/fetch_url.js";
import { webSearch } from "../src/tools.js";

const KEYS = ["FIRECRAWL_API_KEY", "FIRECRAWL_API_URL", "TAVILY_API_KEY", "BOXY_SEARCH_PROVIDER"];

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("firecrawlApiBase", () => {
  test("defaults to the hosted v2 API", () => {
    assert.equal(firecrawlApiBase(), "https://api.firecrawl.dev/v2");
  });

  test("appends /v2 to a self-hosted URL and drops trailing slashes", () => {
    process.env.FIRECRAWL_API_URL = "http://localhost:3002/";
    assert.equal(firecrawlApiBase(), "http://localhost:3002/v2");
  });

  test("leaves a URL that already names a version alone", () => {
    process.env.FIRECRAWL_API_URL = "https://firecrawl.internal/v1";
    assert.equal(firecrawlApiBase(), "https://firecrawl.internal/v1");
  });
});

describe("hasFirecrawl", () => {
  test("is off with no configuration", () => {
    assert.equal(hasFirecrawl(), false);
  });

  test("a self-hosted URL is enough, since those often need no key", () => {
    process.env.FIRECRAWL_API_URL = "http://localhost:3002";
    assert.equal(hasFirecrawl(), true);
  });
});

describe("firecrawlSearch", () => {
  test("rejects a 501-character query before making a request", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called");
    };

    try {
      await assert.rejects(
        firecrawlSearch("x".repeat(501)),
        /at most 500 characters/,
      );
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("webSearch", () => {
  test("says so plainly when no provider is configured", async () => {
    const result = await webSearch("anything");
    assert.match(result.error, /No web search provider is configured/);
  });

  test("ignores provider names that aren't real providers", async () => {
    process.env.BOXY_SEARCH_PROVIDER = "toString,constructor";
    const result = await webSearch("anything");
    assert.match(result.error, /No web search provider is configured/);
  });
});

describe("fetchUrl with Firecrawl enabled", () => {
  beforeEach(() => {
    process.env.FIRECRAWL_API_URL = "http://127.0.0.1:9/unreachable";
  });

  test("a private address is still refused, not handed to the scraper", async () => {
    const result = await fetchUrl("http://169.254.169.254/latest/meta-data/");
    assert.match(result.error, /private or local address/);
    assert.equal(result.markdown, undefined);
  });

  test("a non-http scheme is still refused", async () => {
    const result = await fetchUrl("ftp://example.com/x");
    assert.match(result.error, /Only http and https/);
    assert.equal(result.markdown, undefined);
  });

  test("embedded credentials are still refused", async () => {
    const result = await fetchUrl("https://user:pass@example.com/");
    assert.match(result.error, /embedded credentials/);
    assert.equal(result.markdown, undefined);
  });
});

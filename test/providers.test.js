import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

import {
  readKeyedEnvList,
  providerCredentials,
  expandProviderAttempts,
  callAIWithFallback
} from "../src/ai.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function clearProviderEnv() {
  for (const name of Object.keys(process.env)) {
    if (/_API_(KEY|URL)(_\d+)?$/.test(name) || name.startsWith("BOXY_")) {
      delete process.env[name];
    }
  }
}

beforeEach(clearProviderEnv);

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const name of Object.keys(process.env)) {
    if (!(name in originalEnv)) delete process.env[name];
  }
  Object.assign(process.env, originalEnv);
});

describe("readKeyedEnvList", () => {
  test("is empty when nothing is set", () => {
    assert.deepEqual(readKeyedEnvList("GEMINI_API_KEY"), []);
  });

  test("splits a comma-separated variable", () => {
    process.env.GEMINI_API_KEY = "a, b ,c";
    assert.deepEqual(readKeyedEnvList("GEMINI_API_KEY"), ["a", "b", "c"]);
  });

  test("picks up numbered siblings in numeric order, gaps and all", () => {
    process.env.GEMINI_API_KEY = "first";
    process.env.GEMINI_API_KEY_10 = "tenth";
    process.env.GEMINI_API_KEY_2 = "second";
    assert.deepEqual(readKeyedEnvList("GEMINI_API_KEY"), ["first", "second", "tenth"]);
  });

  test("drops blanks and duplicates", () => {
    process.env.GEMINI_API_KEY = "a,,a, ";
    process.env.GEMINI_API_KEY_2 = "a";
    assert.deepEqual(readKeyedEnvList("GEMINI_API_KEY"), ["a"]);
  });

  test("does not confuse one provider's keys for another's", () => {
    process.env.GROQ_API_KEY = "groq";
    assert.deepEqual(readKeyedEnvList("GEMINI_API_KEY"), []);
  });
});

describe("providerCredentials", () => {
  test("is empty for a provider type with no env prefix", () => {
    assert.deepEqual(providerCredentials("nonexistent"), []);
  });

  test("numbers each key and reports the total", () => {
    process.env.GEMINI_API_KEY = "k1,k2";
    assert.deepEqual(providerCredentials("google"), [
      { apiKey: "k1", baseUrl: null, index: 1, total: 2 },
      { apiKey: "k2", baseUrl: null, index: 2, total: 2 }
    ]);
  });

  test("pairs Ollama hosts with keys by position", () => {
    process.env.OLLAMA_API_KEY = "k1,k2";
    process.env.OLLAMA_API_URL = "http://a,http://b";
    assert.deepEqual(providerCredentials("ollama").map(c => [c.apiKey, c.baseUrl]), [
      ["k1", "http://a"],
      ["k2", "http://b"]
    ]);
  });

  test("lets one key front several hosts", () => {
    process.env.OLLAMA_API_KEY = "shared";
    process.env.OLLAMA_API_URL = "http://a,http://b";
    assert.deepEqual(providerCredentials("ollama").map(c => [c.apiKey, c.baseUrl]), [
      ["shared", "http://a"],
      ["shared", "http://b"]
    ]);
  });

  test("gives extra keys the single configured host", () => {
    process.env.OLLAMA_API_KEY = "k1,k2";
    process.env.OLLAMA_API_URL = "http://only";
    assert.deepEqual(providerCredentials("ollama").map(c => c.baseUrl), ["http://only", "http://only"]);
  });

  test("a host with no key at all yields nothing to try", () => {
    process.env.OLLAMA_API_URL = "http://a";
    assert.deepEqual(providerCredentials("ollama"), []);
  });
});

describe("expandProviderAttempts", () => {
  const PROVIDERS = [
    { name: "gem-a", type: "google", model: "a" },
    { name: "groq-a", type: "groq", model: "b" }
  ];

  test("drops providers that have no key", () => {
    process.env.GEMINI_API_KEY = "k1";
    assert.deepEqual(expandProviderAttempts(PROVIDERS).map(a => a.name), ["gem-a"]);
  });

  test("runs the whole chain on the first key before reaching for the second", () => {
    process.env.GEMINI_API_KEY = "k1,k2,k3";
    process.env.GROQ_API_KEY = "g1,g2";

    const labels = expandProviderAttempts(PROVIDERS).map(a => `${a.name}#${a.credential.index}`);
    assert.deepEqual(labels, ["gem-a#1", "groq-a#1", "gem-a#2", "groq-a#2", "gem-a#3"]);
  });

  test("carries the provider definition through untouched", () => {
    process.env.GEMINI_API_KEY = "k1";
    const [attempt] = expandProviderAttempts(PROVIDERS);
    assert.equal(attempt.model, "a");
    assert.equal(attempt.type, "google");
    assert.equal(attempt.credential.apiKey, "k1");
  });

  test("is empty when nothing is configured", () => {
    assert.deepEqual(expandProviderAttempts(PROVIDERS), []);
  });
});

describe("callAIWithFallback across keys", () => {
  const HELLO = [{ role: "user", parts: [{ text: "hi" }] }];

  function stubFailingFetch(status = 429) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      return {
        ok: false,
        status,
        json: async () => ({}),
        text: async () => "rate limited"
      };
    };
    return calls;
  }

  test("falls through to the second key when the first is rate limited", async () => {
    process.env.BOXY_ENABLED_PROVIDERS = "ollama-gpt-oss-120b";
    process.env.OLLAMA_API_KEY = "k1,k2";
    const calls = stubFailingFetch(429);

    await assert.rejects(callAIWithFallback({ contents: HELLO, tools: [] }), /All AI providers failed/);

    assert.deepEqual(calls.map(c => c.auth), ["Bearer k1", "Bearer k2"]);
  });

  test("sends each key to its paired host", async () => {
    process.env.BOXY_ENABLED_PROVIDERS = "ollama-gpt-oss-120b";
    process.env.OLLAMA_API_KEY = "k1,k2";
    process.env.OLLAMA_API_URL = "http://one,http://two/";
    const calls = stubFailingFetch(500);

    await assert.rejects(callAIWithFallback({ contents: HELLO, tools: [] }), /All AI providers failed/);

    assert.deepEqual(calls.map(c => c.url), [
      "http://one/v1/chat/completions",
      "http://two/v1/chat/completions"
    ]);
  });

  test("names the failing key in the error it reports", async () => {
    process.env.BOXY_ENABLED_PROVIDERS = "ollama-gpt-oss-120b";
    process.env.OLLAMA_API_KEY = "k1,k2";
    stubFailingFetch(500);

    await assert.rejects(
      callAIWithFallback({ contents: HELLO, tools: [] }),
      /ollama-gpt-oss-120b \(key 2\/2\)/
    );
  });

  test("leaves the label bare when the provider has a single key", async () => {
    process.env.BOXY_ENABLED_PROVIDERS = "ollama-gpt-oss-120b";
    process.env.OLLAMA_API_KEY = "only";
    stubFailingFetch(500);

    const error = await callAIWithFallback({ contents: HELLO, tools: [] }).catch(e => e);
    assert.match(error.message, /Provider ollama-gpt-oss-120b failed/);
    assert.doesNotMatch(error.message, /key 1/);
  });
});

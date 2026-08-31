import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

import { callAIWithFallback, ollamaApiBase } from "../src/ai.js";

const KEYS = [
  "OLLAMA_API_KEY",
  "OLLAMA_API_URL",
  "BOXY_ENABLED_PROVIDERS",
  "BOXY_DISABLED_PROVIDERS"
];

const originalFetch = globalThis.fetch;
const savedEnv = {};

beforeEach(() => {
  for (const key of KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.BOXY_ENABLED_PROVIDERS = "ollama";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function stubFetch(payload, status = 200) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    };
  };
  return calls;
}

const HELLO = [{ role: "user", parts: [{ text: "hi" }] }];

describe("ollamaApiBase", () => {
  test("defaults to Ollama Cloud", () => {
    assert.equal(ollamaApiBase(), "https://ollama.com/v1");
  });

  test("appends /v1 to a self-hosted URL and drops trailing slashes", () => {
    process.env.OLLAMA_API_URL = "http://localhost:11434/";
    assert.equal(ollamaApiBase(), "http://localhost:11434/v1");
  });

  test("leaves a URL that already names a version alone", () => {
    process.env.OLLAMA_API_URL = "https://ollama.internal/v1";
    assert.equal(ollamaApiBase(), "https://ollama.internal/v1");
  });
});

describe("the ollama provider", () => {
  test("is skipped without a key, rather than called unauthenticated", async () => {
    const calls = stubFetch({});
    await assert.rejects(
      callAIWithFallback({ contents: HELLO, tools: [] }),
      /All AI providers failed/
    );
    assert.equal(calls.length, 0);
  });

  test("posts to the cloud chat-completions endpoint with the key", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    const calls = stubFetch({
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
    });

    const result = await callAIWithFallback({ contents: HELLO, tools: [] });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://ollama.com/v1/chat/completions");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, "gpt-oss:120b");
    assert.equal(body.stream, false);
    assert.equal(body.tools, undefined);
    assert.match(result.text, /hello/);
  });

  test("sends tools in OpenAI format and parses the tool call back out", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    const calls = stubFetch({
      choices: [{
        message: {
          content: "",
          tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: { path: "a.txt" } } }]
        },
        finish_reason: "tool_calls"
      }]
    });

    const result = await callAIWithFallback({
      contents: HELLO,
      tools: [{ name: "read_file", description: "read", parameters: { type: "OBJECT", properties: { path: { type: "STRING" } }, required: ["path"] } }]
    });

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.tools[0].function.name, "read_file");
    assert.equal(body.tool_choice, "auto");

    assert.deepEqual(result.functionCalls, [{ name: "read_file", args: { path: "a.txt" }, id: "call_1" }]);
    assert.equal(result.candidates[0].finishReason, "STOP");
  });

  test("moves a thinking model's reasoning into the details block", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    stubFetch({
      choices: [{ message: { content: "42", reasoning: "counting carefully" }, finish_reason: "stop" }]
    });

    const result = await callAIWithFallback({ contents: HELLO, tools: [] });

    assert.match(result.text, /counting carefully/);
    assert.match(result.text, /Thought for/);
    assert.equal(result.candidates[0].content.parts[0].text, "42");
  });

  test("surfaces a non-2xx response as a provider failure", async () => {
    process.env.OLLAMA_API_KEY = "sk-test";
    stubFetch({ error: "unauthorized" }, 401);
    await assert.rejects(
      callAIWithFallback({ contents: HELLO, tools: [] }),
      /Ollama Status 401/
    );
  });
});

import { describe, beforeEach, test } from "node:test";
import assert from "node:assert";

import { guardPings, findMentions, clearPingGuardCache } from "../src/ping_guard.js";

const ENV = {};

function notFound() {
  const err = new Error("Not Found");
  err.status = 404;
  return err;
}

function forbidden() {
  const err = new Error("Must have admin rights to Repository.");
  err.status = 403;
  return err;
}

function fakeOctokit({ members = [], collaborators = [], orgError = null } = {}) {
  const calls = { membership: 0, collaborator: 0 };

  return {
    calls,
    rest: {
      orgs: {
        checkMembershipForUser: async ({ username }) => {
          calls.membership++;
          if (orgError) throw orgError;
          if (!members.includes(username.toLowerCase())) throw notFound();
          return { status: 204 };
        }
      },
      repos: {
        checkCollaborator: async ({ username }) => {
          calls.collaborator++;
          if (!collaborators.includes(username.toLowerCase())) throw notFound();
          return { status: 204 };
        }
      }
    }
  };
}

const silentLog = { warn() {}, info() {} };

function guard(text, octokit, extra = {}) {
  return guardPings(text, {
    octokit,
    owner: "Spelling-Creator",
    repo: "boxy",
    log: silentLog,
    env: ENV,
    ...extra
  });
}

describe("ping guard", () => {
  beforeEach(() => {
    clearPingGuardCache();
  });

  test("defuses a mention of someone outside the org", async () => {
    const octokit = fakeOctokit({ members: ["ampelc"] });
    const result = await guard("Hey @randomstranger, look at this", octokit);

    assert.strictEqual(result, "Hey `@randomstranger`, look at this");
  });

  test("leaves a mention of an org member alone", async () => {
    const octokit = fakeOctokit({ members: ["ampelc"] });
    const result = await guard("Thanks @ampelc!", octokit);

    assert.strictEqual(result, "Thanks @ampelc!");
  });

  test("falls back to repo collaborators when org membership isn't readable", async () => {
    const octokit = fakeOctokit({ orgError: forbidden(), collaborators: ["outsidefriend"] });

    assert.strictEqual(await guard("ping @outsidefriend", octokit), "ping @outsidefriend");
    assert.strictEqual(await guard("ping @nobody", octokit), "ping `@nobody`");
  });

  test("allows team mentions in our own org but not other orgs", async () => {
    const octokit = fakeOctokit();
    const result = await guard("@Spelling-Creator/boxy vs @Other-Org/security", octokit);

    assert.strictEqual(result, "@Spelling-Creator/boxy vs `@Other-Org/security`");
  });

  test("defuses everything when there is no way to check", async () => {
    const result = await guard("cc @someone", null);

    assert.strictEqual(result, "cc `@someone`");
  });

  test("honors the per-call allow list (the person Boxy is replying to)", async () => {
    const octokit = fakeOctokit();
    const result = await guard("Hi, @drive-by-contributor!", octokit, { allow: ["drive-by-contributor"] });

    assert.strictEqual(result, "Hi, @drive-by-contributor!");
  });

  test("honors BOXY_PING_ALLOWLIST", async () => {
    const octokit = fakeOctokit();
    const result = await guard("cc @friendly-bot", octokit, {
      env: { BOXY_PING_ALLOWLIST: "@friendly-bot, someone-else" }
    });

    assert.strictEqual(result, "cc @friendly-bot");
  });

  test("can be turned off entirely", async () => {
    const result = await guard("cc @randomstranger", null, { env: { BOXY_PING_GUARD: "off" } });

    assert.strictEqual(result, "cc @randomstranger");
  });

  test("ignores @ that GitHub would never turn into a ping", async () => {
    const body = [
      "Email me at boxy@example.com",
      "Inline code: `@randomstranger`",
      "",
      "```js",
      "// @randomstranger in a code fence",
      "```",
      "",
      "<!-- @randomstranger in a comment -->",
      "https://example.com/@randomstranger",
      "[docs](https://example.com/@randomstranger)"
    ].join("\n");

    assert.deepStrictEqual(findMentions(body), []);
    assert.strictEqual(await guard(body, fakeOctokit()), body);
  });

  test("is idempotent, so double-guarding a body is harmless", async () => {
    const octokit = fakeOctokit({ members: ["ampelc"] });
    const once = await guard("@ampelc and @randomstranger", octokit);
    const twice = await guard(once, octokit);

    assert.strictEqual(once, "@ampelc and `@randomstranger`");
    assert.strictEqual(twice, once);
  });

  test("caches lookups instead of asking GitHub per mention", async () => {
    const octokit = fakeOctokit({ members: ["ampelc"] });
    await guard("@ampelc @ampelc @ampelc", octokit);
    await guard("@ampelc again", octokit);

    assert.strictEqual(octokit.calls.membership, 1);
  });

  test("defuses every outside mention in a longer body", async () => {
    const octokit = fakeOctokit({ members: ["ampelc"] });
    const result = await guard(
      "cc @randomstranger and @anotherone - @ampelc already knows.",
      octokit
    );

    assert.strictEqual(result, "cc `@randomstranger` and `@anotherone` - @ampelc already knows.");
  });
});

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

  test("reads a hyphenated login in full instead of stopping at the hyphen", async () => {
    const octokit = fakeOctokit({ members: ["playforge-coding"] });

    assert.deepStrictEqual(
      findMentions("thanks @PlayForge-coding!").map(m => m.name),
      ["PlayForge-coding"]
    );
    assert.strictEqual(await guard("thanks @PlayForge-coding!", octokit), "thanks @PlayForge-coding!");
  });

  test("trims a malformed mention to the prefix GitHub would actually link", async () => {
    const octokit = fakeOctokit({ members: ["playforge-coding"] });

    assert.strictEqual(await guard("@playforge-coding- shipped it", octokit), "@playforge-coding- shipped it");
    assert.strictEqual(await guard("cc @play--forge", octokit), "cc `@play`--forge");
    assert.strictEqual(await guard("cc @outsider- please", octokit), "cc `@outsider`- please");
  });

  test("catches a mention that follows a hyphen", async () => {
    const octokit = fakeOctokit({ members: ["playforge-coding"] });

    assert.strictEqual(await guard("-@randomstranger", octokit), "-`@randomstranger`");
    assert.strictEqual(await guard("-@playforge-coding", octokit), "-@playforge-coding");
  });

  test("a truncated login can't smuggle a team mention past the guard", async () => {
    const octokit = fakeOctokit();
    const result = await guard("@Spelling--Creator/boxy", octokit);

    assert.strictEqual(result, "`@Spelling`--Creator/boxy");
  });

  const NON_BREAKING_HYPHEN = String.fromCharCode(0x2011);
  const EN_DASH = String.fromCharCode(0x2013);
  const ZERO_WIDTH_SPACE = String.fromCharCode(0x200B);

  test("repairs a lookalike hyphen so the ping reaches the person it names", async () => {
    const octokit = fakeOctokit({ members: ["playforge-coding"] });

    assert.strictEqual(
      await guard(`thanks @playforge${NON_BREAKING_HYPHEN}coding!`, octokit),
      "thanks @playforge-coding!"
    );
    assert.strictEqual(
      await guard(`thanks @PlayForge${EN_DASH}coding!`, octokit),
      "thanks @PlayForge-coding!"
    );
  });

  test("a lookalike hyphen can't leak a ping to the ascii prefix", async () => {
    const octokit = fakeOctokit({ members: ["playforge-coding"] });
    const result = await guard(`cc @outsider${NON_BREAKING_HYPHEN}person`, octokit);

    assert.strictEqual(result, "cc `@outsider-person`");
  });

  test("drops invisible characters instead of pinging the prefix before them", async () => {
    const octokit = fakeOctokit({ members: ["playforge-coding"] });
    const result = await guard(`cc @playforge${ZERO_WIDTH_SPACE}coding`, octokit);

    assert.strictEqual(result, "cc `@playforgecoding`");
  });

  test("a repaired mention stays put when guarded again", async () => {
    const octokit = fakeOctokit({ members: ["playforge-coding"] });
    const once = await guard(`@playforge${NON_BREAKING_HYPHEN}coding ping`, octokit);
    const twice = await guard(once, octokit);

    assert.strictEqual(once, "@playforge-coding ping");
    assert.strictEqual(twice, once);
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

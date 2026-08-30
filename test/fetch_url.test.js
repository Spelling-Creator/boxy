import { describe, test } from "node:test";
import assert from "node:assert";

import {
  normalizeUrl,
  isPrivateAddress,
  htmlToMarkdown,
  decodeEntities,
  fetchUrl,
} from "../src/fetch_url.js";

describe("normalizeUrl", () => {
  test("rewrites GitHub blob URLs to raw URLs", () => {
    assert.equal(
      normalizeUrl("https://github.com/Spelling-Creator/boxy/blob/main/src/index.js"),
      "https://raw.githubusercontent.com/Spelling-Creator/boxy/main/src/index.js",
    );
  });

  test("drops the query and fragment a blob link carries", () => {
    assert.equal(
      normalizeUrl("https://github.com/o/r/blob/main/docs/a b.md?plain=1#L4-L9"),
      "https://raw.githubusercontent.com/o/r/main/docs/a%20b.md",
    );
  });

  test("keeps branch names that contain slashes intact", () => {
    assert.equal(
      normalizeUrl("https://github.com/o/r/blob/feature/my-branch/a/b.md"),
      "https://raw.githubusercontent.com/o/r/feature/my-branch/a/b.md",
    );
  });

  test("handles /raw/ links and the www host", () => {
    assert.equal(
      normalizeUrl("https://www.github.com/o/r/raw/main/README.md"),
      "https://raw.githubusercontent.com/o/r/main/README.md",
    );
  });

  test("leaves other GitHub URLs and other hosts alone", () => {
    assert.equal(normalizeUrl("https://github.com/o/r/pull/12"), "https://github.com/o/r/pull/12");
    assert.equal(normalizeUrl("https://example.com/a.pdf"), "https://example.com/a.pdf");
  });
});

describe("isPrivateAddress", () => {
  test("blocks loopback, link-local, and private ranges", () => {
    for (const address of ["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255",
      "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1"]) {
      assert.equal(isPrivateAddress(address), true, `${address} should be private`);
    }
  });

  test("allows ordinary public addresses", () => {
    for (const address of ["8.8.8.8", "140.82.121.4", "172.32.0.1", "2606:4700:4700::1111"]) {
      assert.equal(isPrivateAddress(address), false, `${address} should be public`);
    }
  });

  test("treats anything that isn't an IP as unsafe", () => {
    assert.equal(isPrivateAddress("not-an-ip"), true);
  });
});

describe("decodeEntities", () => {
  test("decodes named and numeric entities", () => {
    assert.equal(decodeEntities("a &amp; b &lt;c&gt; &#65; &#x42; &mdash;"), "a & b <c> A B —");
  });

  test("leaves unknown entities as written", () => {
    assert.equal(decodeEntities("&notareal; &amp;"), "&notareal; &");
  });
});

describe("htmlToMarkdown", () => {
  const page = `<!doctype html><html><head><title>Doc &amp; Guide</title>
    <style>body { color: red }</style><script>alert(1)</script></head>
    <body><nav>navigation junk</nav><main>
      <h2>Heading <em>here</em></h2>
      <p>Some <strong>bold</strong> text and a <a href="/next">link</a>.</p>
      <ul><li>one</li><li>two</li></ul>
      <pre><code class="language-js">const a = 1;</code></pre>
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
    </main><footer>footer junk</footer></body></html>`;

  test("pulls out the title", () => {
    assert.equal(htmlToMarkdown(page).title, "Doc & Guide");
  });

  test("keeps only the main content", () => {
    const { markdown } = htmlToMarkdown(page);
    assert.ok(!markdown.includes("navigation junk"));
    assert.ok(!markdown.includes("footer junk"));
    assert.ok(!markdown.includes("alert(1)"));
    assert.ok(!markdown.includes("color: red"));
  });

  test("converts headings, emphasis, lists, code and tables", () => {
    const { markdown } = htmlToMarkdown(page);
    assert.ok(markdown.includes("## Heading *here*"));
    assert.ok(markdown.includes("Some **bold** text"));
    assert.ok(markdown.includes("- one\n- two"));
    assert.ok(markdown.includes("```js\nconst a = 1;\n```"));
    assert.ok(markdown.includes("| A | B |\n| --- | --- |\n| 1 | 2 |"));
  });

  test("resolves relative links against the page URL", () => {
    const { markdown } = htmlToMarkdown(page, "https://example.com/docs/guide");
    assert.ok(markdown.includes("[link](https://example.com/next)"));
  });

  test("survives unclosed tags without throwing", () => {
    const { markdown } = htmlToMarkdown("<p>one<p>two<ul><li>three");
    assert.ok(markdown.includes("one"));
    assert.ok(markdown.includes("- three"));
  });
});

describe("fetchUrl", () => {
  test("refuses non-http schemes", async () => {
    const result = await fetchUrl("ftp://example.com/x");
    assert.match(result.error, /Only http and https/);
  });

  test("refuses URLs that resolve to private addresses", async () => {
    const result = await fetchUrl("http://169.254.169.254/latest/meta-data/");
    assert.match(result.error, /private or local address/);
  });

  test("refuses URLs carrying credentials", async () => {
    const result = await fetchUrl("https://user:pass@example.com/");
    assert.match(result.error, /embedded credentials/);
  });

  test("reports a missing URL instead of throwing", async () => {
    assert.match((await fetchUrl("")).error, /No URL/);
  });
});

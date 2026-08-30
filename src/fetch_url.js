import dns from "node:dns/promises";
import net from "node:net";

import { hasFirecrawl, firecrawlScrape } from "./firecrawl.js";

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_MARKDOWN_CHARS = 25000;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 20000;
const USER_AGENT = "boxy-sc[bot] (+https://github.com/Spelling-Creator/boxy)";

export function normalizeUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    return String(rawUrl).trim();
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "github.com") return url.toString();

  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length >= 5 && (segments[2] === "blob" || segments[2] === "raw")) {
    const [owner, repo, , ...rest] = segments;
    const path = rest.map(encodeURIComponent).join("/");
    return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${path}`;
  }

  return url.toString();
}

/**
 * True for addresses that no webhook-triggered fetch has any business reaching:
 * loopback, link-local (including the cloud metadata endpoint), private and
 * carrier-grade NAT ranges, multicast, and the IPv6 equivalents.
 * @param {string} address
 * @returns {boolean}
 */
export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return true;

  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }

  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  const mapped = normalized.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (/^f[cd]/.test(normalized)) return true;           // unique local fc00::/7
  if (/^fe[89ab]/.test(normalized)) return true;        // link local fe80::/10
  if (normalized.startsWith("ff")) return true;         // multicast
  return false;
}

export class UrlNotAllowedError extends Error {
  constructor(message) {
    super(message);
    this.name = "UrlNotAllowedError";
  }
}

async function assertFetchable(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    throw new UrlNotAllowedError(`'${target}' is not a valid URL.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlNotAllowedError(`Only http and https URLs can be fetched, not '${url.protocol}'.`);
  }
  if (url.username || url.password) {
    throw new UrlNotAllowedError("URLs with embedded credentials are not fetched.");
  }

  let addresses;
  try {
    addresses = await dns.lookup(url.hostname, { all: true });
  } catch (err) {
    throw new UrlNotAllowedError(`Could not resolve '${url.hostname}': ${err.message}`);
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new UrlNotAllowedError(`'${url.hostname}' resolves to a private or local address, which is not fetchable.`);
  }

  return url;
}

async function fetchFollowingRedirects(target) {
  let current = target;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertFetchable(current);
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,text/markdown,text/plain,application/json,application/pdf;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const location = response.status >= 300 && response.status < 400
      ? response.headers.get("location")
      : null;
    if (!location) return { response, finalUrl: url.toString() };

    await response.body?.cancel().catch(() => {});
    current = new URL(location, url).toString();
  }

  throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
}

async function readCapped(response) {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };

  const chunks = [];
  let total = 0;
  let truncated = false;

  for await (const chunk of response.body) {
    const piece = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (total + piece.length > MAX_RESPONSE_BYTES) {
      chunks.push(piece.subarray(0, MAX_RESPONSE_BYTES - total));
      total = MAX_RESPONSE_BYTES;
      truncated = true;
      break;
    }
    chunks.push(piece);
    total += piece.length;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

let anydocPromise = null;

function loadAnydoc() {
  if (!anydocPromise) {
    anydocPromise = import("@firecrawl/anydoc").catch(() => null);
  }
  return anydocPromise;
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ",
  thinsp: " ", shy: "", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", middot: "·",
  bull: "•", copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×",
  divide: "÷", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶",
  dagger: "†", Dagger: "‡", larr: "←", rarr: "→", harr: "↔", darr: "↓", uarr: "↑",
};

export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

const DROPPED = new Set(["script", "style", "noscript", "svg", "canvas", "iframe", "template", "head", "title", "select", "option", "button", "picture", "source", "math"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "dd", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5",
  "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

function tokenizeHtml(html) {
  const tokens = [];
  let index = 0;

  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next === -1) {
      tokens.push({ type: "text", value: html.slice(index) });
      break;
    }
    if (next > index) tokens.push({ type: "text", value: html.slice(index, next) });

    if (html.startsWith("<!--", next)) {
      const end = html.indexOf("-->", next);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", next) || html.startsWith("<?", next)) {
      const end = html.indexOf(">", next);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(html.slice(next));
    if (!match) {
      tokens.push({ type: "text", value: "<" });
      index = next + 1;
      continue;
    }

    const [raw, slash, rawName, rawAttrs] = match;
    const name = rawName.toLowerCase();
    index = next + raw.length;

    if (slash) {
      tokens.push({ type: "close", name });
      continue;
    }

    const attrs = {};
    for (const attr of rawAttrs.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
      const value = attr[2] ? attr[2].replace(/^["']|["']$/g, "") : "";
      attrs[attr[1].toLowerCase()] = decodeEntities(value);
    }
    tokens.push({ type: "open", name, attrs });

    if (RAW_TEXT.has(name) && !rawAttrs.trimEnd().endsWith("/")) {
      const closeIndex = html.toLowerCase().indexOf(`</${name}`, index);
      const end = closeIndex === -1 ? html.length : closeIndex;
      tokens.push({ type: "text", value: html.slice(index, end) });
      tokens.push({ type: "close", name });
      index = end === -1 ? html.length : end;
      const gt = html.indexOf(">", index);
      index = gt === -1 ? html.length : gt + 1;
    }
  }

  return tokens;
}

function mainContent(html) {
  for (const tag of ["main", "article", "body"]) {
    const open = new RegExp(`<${tag}[\\s>]`, "i").exec(html);
    if (!open) continue;
    const start = html.indexOf(">", open.index);
    const end = html.toLowerCase().lastIndexOf(`</${tag}>`);
    if (start !== -1 && end > start) return html.slice(start + 1, end);
  }
  return html;
}

export function htmlToMarkdown(html, baseUrl) {
  const source = String(html ?? "");
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() || null : null;
  const body = mainContent(source);

  const blocks = [];
  const listStack = [];
  let inline = "";
  let prefix = "";
  let quoteDepth = 0;
  let dropDepth = 0;
  let preDepth = 0;
  let preLang = "";
  let table = null;
  let row = null;
  const links = [];
  let listRoot = 0;

  const resolve = (value) => {
    if (!value || !baseUrl) return value;
    try {
      return new URL(value, baseUrl).toString();
    } catch {
      return value;
    }
  };

  const flush = () => {
    const text = inline.replace(/[ \t]+\n/g, "\n").trim();
    inline = "";
    if (!text) {
      prefix = "";
      return;
    }
    const quote = "> ".repeat(quoteDepth);
    const indent = "  ".repeat(Math.max(0, listStack.length - 1));
    const rendered = `${prefix}${text}`.split("\n").join(`\n${quote}${indent}`);
    blocks.push({ text: `${quote}${indent}${rendered}`, list: listStack.length > 0 ? listRoot : 0 });
    prefix = "";
  };

  const write = (text) => {
    if (row) {
      if (row.length === 0) row.push("");
      row[row.length - 1] += text;
    } else {
      inline += text;
    }
  };

  for (const token of tokenizeHtml(body)) {
    if (token.type === "text") {
      if (dropDepth > 0) continue;
      const decoded = decodeEntities(token.value);
      if (preDepth > 0) {
        inline += decoded;
        continue;
      }
      const collapsed = decoded.replace(/\s+/g, " ");
      if (!collapsed.trim() && !inline.endsWith(" ") && inline) inline += " ";
      else if (collapsed.trim()) write(collapsed);
      continue;
    }

    const { name } = token;

    if (token.type === "open") {
      if (DROPPED.has(name)) {
        dropDepth++;
        continue;
      }
      if (dropDepth > 0) continue;

      if (preDepth > 0 && name !== "pre" && name !== "code") continue;
      if (BLOCK_ELEMENTS.has(name) && preDepth === 0 && !row) flush();

      switch (name) {
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
          prefix = `${"#".repeat(Number(name[1]))} `;
          break;
        case "br":
          write("\n");
          break;
        case "hr":
          blocks.push({ text: "---", list: 0 });
          break;
        case "ul": case "ol":
          if (listStack.length === 0) listRoot++;
          listStack.push({ ordered: name === "ol", index: Number(token.attrs?.start) || 1 });
          break;
        case "li": {
          const list = listStack[listStack.length - 1];
          if (!list) listStack.push({ ordered: false, index: 1 });
          const current = listStack[listStack.length - 1];
          prefix = current.ordered ? `${current.index++}. ` : "- ";
          break;
        }
        case "blockquote":
          quoteDepth++;
          break;
        case "pre":
          preDepth++;
          preLang = "";
          break;
        case "code":
          if (preDepth > 0) {
            const cls = token.attrs?.class || "";
            const lang = /(?:language|lang)-([\w+#.-]+)/.exec(cls);
            if (lang) preLang = lang[1];
          } else {
            write("`");
          }
          break;
        case "strong": case "b":
          write("**");
          break;
        case "em": case "i":
          write("*");
          break;
        case "del": case "s": case "strike":
          write("~~");
          break;
        case "a": {
          const href = resolve(token.attrs?.href || "");
          links.push(href);
          if (href) write("[");
          break;
        }
        case "img": {
          const alt = (token.attrs?.alt || "").replace(/[\[\]]/g, "");
          const src = token.attrs?.src || "";
          const resolved = src.startsWith("data:") ? src : resolve(src);
          if (src && !src.startsWith("data:")) write(`![${alt}](${resolved})`);
          else if (alt) write(alt);
          break;
        }
        case "table":
          flush();
          table = { rows: [], headerRows: 0 };
          break;
        case "tr":
          if (table) row = [];
          break;
        case "th": case "td":
          if (table && !row) row = [];
          if (table) row.push("");
          break;
        default:
          break;
      }
      continue;
    }

    if (DROPPED.has(name)) {
      if (dropDepth > 0) dropDepth--;
      continue;
    }
    if (dropDepth > 0) continue;
    if (preDepth > 0 && name !== "pre") continue;

    switch (name) {
      case "ul": case "ol":
        flush();
        listStack.pop();
        break;
      case "blockquote":
        flush();
        if (quoteDepth > 0) quoteDepth--;
        break;
      case "pre": {
        preDepth = Math.max(0, preDepth - 1);
        const code = inline.replace(/^\n+|\s+$/g, "");
        inline = "";
        if (code) blocks.push({ text: `\`\`\`${preLang}\n${code}\n\`\`\``, list: listStack.length > 0 ? listRoot : 0 });
        preLang = "";
        break;
      }
      case "code":
        if (preDepth === 0) write("`");
        break;
      case "strong": case "b":
        write("**");
        break;
      case "em": case "i":
        write("*");
        break;
      case "del": case "s": case "strike":
        write("~~");
        break;
      case "a": {
        const href = links.pop();
        if (href) write(`](${href})`);
        break;
      }
      case "th": case "td":
        break;
      case "tr":
        if (table && row) {
          table.rows.push(row.map((cell) => cell.replace(/\s+/g, " ").trim() || " "));
          if (table.rows.length === 1) table.headerRows = 1;
        }
        row = null;
        break;
      case "table": {
        if (table && table.rows.length) {
          const width = Math.max(...table.rows.map((cells) => cells.length));
          const pad = (cells) => Array.from({ length: width }, (_, i) => (cells[i] ?? " ").replace(/\|/g, "\\|"));
          const [head, ...rest] = table.rows;
          const lines = [
            `| ${pad(head).join(" | ")} |`,
            `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
            ...rest.map((cells) => `| ${pad(cells).join(" | ")} |`),
          ];
          blocks.push({ text: lines.join("\n"), list: 0 });
        }
        table = null;
        row = null;
        break;
      }
      default:
        if (BLOCK_ELEMENTS.has(name)) flush();
        break;
    }
  }

  flush();

  const markdown = blocks
    .reduce((acc, block, i) => {
      if (i === 0) return block.text;
      const separator = block.list && block.list === blocks[i - 1].list ? "\n" : "\n\n";
      return acc + separator + block.text;
    }, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title, markdown };
}

function isTextual(mediaType) {
  return mediaType.startsWith("text/")
    || /^application\/(json|xml|x-yaml|yaml|javascript|x-javascript|ld\+json|graphql|toml|x-sh|x-httpd-php)$/.test(mediaType)
    || /\+(json|xml|yaml)$/.test(mediaType);
}

function capMarkdown(text) {
  if (text.length <= MAX_MARKDOWN_CHARS) return { content: text, truncated: false };
  return {
    content: `${text.slice(0, MAX_MARKDOWN_CHARS)}\n\n... [CONTENT TRUNCATED FOR SIZE]`,
    truncated: true,
  };
}

async function scrapeWithFirecrawl(url, extra = {}) {
  if (!hasFirecrawl()) return null;

  let scraped;
  try {
    scraped = await firecrawlScrape(url);
  } catch {
    return null;
  }

  const { content, truncated } = capMarkdown(scraped.markdown);
  const mediaType = scraped.contentType || "text/html";
  const format = mediaType === "text/html" || mediaType === "application/xhtml+xml"
    ? "html"
    : mediaType.split("/")[1] || "html";

  return {
    url: scraped.url,
    ...extra,
    content_type: mediaType,
    format,
    ...(scraped.title && { title: scraped.title }),
    markdown: content,
    truncated,
    via: "firecrawl",
  };
}

export async function fetchUrl(target) {
  if (!target || typeof target !== "string") {
    return { error: "No URL was given to fetch." };
  }

  const normalized = normalizeUrl(target);
  const rewritten = normalized !== String(target).trim();

  const rewriteNote = rewritten
    ? { requested_url: String(target).trim(), note: "GitHub blob URL was rewritten to its raw URL." }
    : {};

  let response;
  let finalUrl;
  try {
    ({ response, finalUrl } = await fetchFollowingRedirects(normalized));
  } catch (err) {
    if (err instanceof UrlNotAllowedError) return { error: `Could not fetch ${normalized}: ${err.message}` };
    const scraped = await scrapeWithFirecrawl(normalized, rewriteNote);
    if (scraped) return scraped;
    return { error: `Could not fetch ${normalized}: ${err.message}` };
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const scraped = await scrapeWithFirecrawl(normalized, rewriteNote);
    if (scraped) return scraped;
    return {
      error: `${normalized} responded with ${response.status} ${response.statusText || ""}`.trim(),
      status: response.status,
      ...(rewritten && { fetched_url: normalized }),
    };
  }

  let bytes;
  let sizeTruncated;
  try {
    ({ bytes, truncated: sizeTruncated } = await readCapped(response));
  } catch (err) {
    return { error: `Could not read the response from ${normalized}: ${err.message}` };
  }

  if (bytes.length === 0) {
    const scraped = await scrapeWithFirecrawl(normalized, rewriteNote);
    if (scraped) return scraped;
    return { error: `${normalized} returned an empty response.` };
  }

  const contentType = response.headers.get("content-type") || "";
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  const base = {
    url: finalUrl,
    ...rewriteNote,
    content_type: mediaType || "unknown",
  };

  const anydoc = await loadAnydoc();
  if (anydoc) {
    let format = null;
    try {
      format = anydoc.formatFromBytes(bytes);
    } catch {
      format = null;
    }
    if (!format) {
      const path = (() => {
        try { return new URL(finalUrl).pathname; } catch { return ""; }
      })();
      const byPath = anydoc.formatFromPath(path);
      if (byPath) format = byPath;
      else if (mediaType === "text/csv") format = "csv";
    }

    if (format) {
      try {
        const markdown = await anydoc.toMarkdownBytes(bytes, format);
        const { content, truncated } = capMarkdown(markdown.trim());
        return { ...base, format, markdown: content, truncated: truncated || sizeTruncated };
      } catch (err) {
        return {
          ...base,
          error: err.code === "needsOcr"
            ? `Fetched the ${format} at ${finalUrl}, but its pages are scanned images with no text layer, so there is nothing to convert. Say that plainly instead of guessing at the contents.`
            : `Fetched the ${format} at ${finalUrl} but could not convert it to Markdown (${err.code || "conversion failed"}): ${err.message}`,
        };
      }
    }
  }

  const looksHtml = mediaType === "text/html" || mediaType === "application/xhtml+xml";
  if (!looksHtml && !isTextual(mediaType) && mediaType) {
    return { ...base, error: `${finalUrl} is '${mediaType}', which cannot be turned into Markdown. Only web pages, text, and documents work here.` };
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  if (looksHtml || (!mediaType && /^\s*(<!doctype html|<html)/i.test(text))) {
    const { title, markdown } = htmlToMarkdown(text, finalUrl);
    if (!markdown) {
      const scraped = await scrapeWithFirecrawl(finalUrl, rewriteNote);
      if (scraped) return scraped;
      return { ...base, format: "html", title, error: `No readable text could be extracted from ${finalUrl}.` };
    }
    const { content, truncated } = capMarkdown(markdown);
    return { ...base, format: "html", ...(title && { title }), markdown: content, truncated: truncated || sizeTruncated };
  }

  const isMarkdown = mediaType === "text/markdown" || /\.(md|markdown|mdx)$/i.test(new URL(finalUrl).pathname);
  const { content, truncated } = capMarkdown(text.trim());
  return { ...base, format: isMarkdown ? "markdown" : "text", content, truncated: truncated || sizeTruncated };
}

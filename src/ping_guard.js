const DEFAULT_ALLOWLIST = ["boxy-sc"];
const MEMBERSHIP_TTL_MS = 10 * 60 * 1000;

const membershipCache = new Map();

function cacheKey(org, name) {
  return `${String(org).toLowerCase()}/${String(name).toLowerCase()}`;
}

function readCache(org, name) {
  const entry = membershipCache.get(cacheKey(org, name));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    membershipCache.delete(cacheKey(org, name));
    return null;
  }
  return entry;
}

function writeCache(org, name, allowed) {
  membershipCache.set(cacheKey(org, name), { allowed, expiresAt: Date.now() + MEMBERSHIP_TTL_MS });
}

export function clearPingGuardCache() {
  membershipCache.clear();
}

export function isPingGuardEnabled(env = process.env) {
  return String(env.BOXY_PING_GUARD || "").trim().toLowerCase() !== "off";
}

export function parseAllowlist(env = process.env) {
  const configured = String(env.BOXY_PING_ALLOWLIST || "")
    .split(",")
    .map(name => name.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);

  return new Set([...DEFAULT_ALLOWLIST, ...configured]);
}

function linkableLogin(candidate) {
  const match = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*/.exec(candidate);
  if (!match) return null;
  return match[0].length <= 39 ? match[0] : null;
}

function pushRange(ranges, start, end) {
  if (end > start) ranges.push([start, end]);
}

function protectedRanges(text) {
  const ranges = [];

  let offset = 0;
  let openFence = null;
  let fenceStart = 0;
  for (const line of text.split("\n")) {
    const fence = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (openFence === null) {
      if (fence && !(fence[1][0] === "`" && line.slice(fence[0].length).includes("`"))) {
        openFence = fence[1][0];
        fenceStart = offset;
      }
    } else if (fence && fence[1][0] === openFence) {
      pushRange(ranges, fenceStart, offset + line.length);
      openFence = null;
    }
    offset += line.length + 1;
  }
  if (openFence !== null) pushRange(ranges, fenceStart, text.length);

  const patterns = [
    /(`+)[^\n]*?\1/g,
    /<!--[\s\S]*?-->/g,
    /<[^>\s]+@[^>\s]+>/g,
    /\bhttps?:\/\/\S+/g,
    /\]\([^)\s]*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      pushRange(ranges, match.index, match.index + match[0].length);
    }
  }

  return ranges;
}

function isProtected(ranges, index) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

const MENTION = /(^|[^A-Za-z0-9_@/\\])@([A-Za-z0-9-]+)(\/([A-Za-z0-9._-]{1,100}))?/g;

export function findMentions(text) {
  if (!text || typeof text !== "string") return [];

  const ranges = protectedRanges(text);
  const mentions = [];

  for (const match of text.matchAll(MENTION)) {
    const index = match.index + match[1].length;
    if (isProtected(ranges, index)) continue;

    const login = linkableLogin(match[2]);
    if (!login) continue;

    const team = login === match[2] ? (match[4] || null) : null;

    mentions.push({
      raw: team ? `@${login}/${team}` : `@${login}`,
      name: login,
      team,
      index,
    });
  }

  return mentions;
}

async function isInsideOrg(login, { octokit, org, repo, log }) {
  const cached = readCache(org, login);
  if (cached) return cached.allowed;

  let allowed = false;

  if (octokit && org) {
    try {
      await octokit.rest.orgs.checkMembershipForUser({ org, username: login });
      allowed = true;
    } catch (err) {
      if (err?.status !== 404 && log?.warn) {
        log.warn(`[PING GUARD] org membership lookup for @${login} in ${org} failed: ${err.message}`);
      }

      if (repo) {
        try {
          await octokit.rest.repos.checkCollaborator({ owner: org, repo, username: login });
          allowed = true;
        } catch (collabErr) {
          if (collabErr?.status !== 404 && log?.warn) {
            log.warn(`[PING GUARD] collaborator lookup for @${login} on ${org}/${repo} failed: ${collabErr.message}`);
          }
        }
      }
    }
  }

  writeCache(org, login, allowed);
  return allowed;
}

export function defuseMention(raw) {
  return `\`${raw}\``;
}

export async function guardPings(text, { octokit, owner, repo, log = console, allow = [], env = process.env } = {}) {
  if (!text || typeof text !== "string") return text;
  if (!isPingGuardEnabled(env)) return text;

  const org = (env.BOXY_PING_ORG || owner || "").trim();
  const mentions = findMentions(text);
  if (mentions.length === 0) return text;

  const allowlist = parseAllowlist(env);
  for (const login of allow) {
    if (login) allowlist.add(String(login).replace(/^@/, "").toLowerCase());
  }
  const verdicts = new Map();

  for (const mention of mentions) {
    const key = mention.raw.toLowerCase();
    if (verdicts.has(key)) continue;

    if (mention.team) {
      verdicts.set(key, org ? mention.name.toLowerCase() === org.toLowerCase() : false);
      continue;
    }

    if (allowlist.has(mention.name.toLowerCase())) {
      verdicts.set(key, true);
      continue;
    }

    verdicts.set(key, await isInsideOrg(mention.name, { octokit, org, repo, log }));
  }

  const blocked = [];
  let guarded = "";
  let cursor = 0;

  for (const mention of mentions) {
    if (verdicts.get(mention.raw.toLowerCase())) continue;
    blocked.push(mention.raw);
    guarded += text.slice(cursor, mention.index) + defuseMention(mention.raw);
    cursor = mention.index + mention.raw.length;
  }

  if (blocked.length === 0) return text;

  guarded += text.slice(cursor);
  log?.warn?.(`[PING GUARD] Defused ${blocked.length} mention(s) outside ${org || "the org"}: ${blocked.join(", ")}`);

  return guarded;
}

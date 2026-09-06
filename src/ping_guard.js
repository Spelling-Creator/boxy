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

const DASH_LOOKALIKE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/;
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/;

function normalizeRun(run) {
  let login = "";
  const sourceIndex = [];

  for (let i = 0; i < run.length; i++) {
    const char = run[i];
    if (INVISIBLE.test(char)) continue;
    login += DASH_LOOKALIKE.test(char) ? "-" : char;
    sourceIndex.push(i);
  }

  return { login, sourceIndex };
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

const LOOKALIKES = DASH_LOOKALIKE.source.slice(1, -1) + INVISIBLE.source.slice(1, -1);
const MENTION = new RegExp(
  `(^|[^A-Za-z0-9_@/\\\\])@([A-Za-z0-9${LOOKALIKES}-]+)(/([A-Za-z0-9._${LOOKALIKES}-]{1,100}))?`,
  "g"
);

export function findMentions(text) {
  if (!text || typeof text !== "string") return [];

  const ranges = protectedRanges(text);
  const mentions = [];

  for (const match of text.matchAll(MENTION)) {
    const index = match.index + match[1].length;
    if (isProtected(ranges, index)) continue;

    const run = match[2];
    const { login: intended, sourceIndex } = normalizeRun(run);
    const login = linkableLogin(intended);
    if (!login) continue;

    const team = login === intended && match[4] ? normalizeRun(match[4]).login : null;
    const consumed = sourceIndex[login.length - 1] + 1;

    mentions.push({
      source: `@${run.slice(0, consumed)}${team ? match[3] : ""}`,
      clean: team ? `@${login}/${team}` : `@${login}`,
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
    const key = mention.clean.toLowerCase();
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
  const repaired = [];
  let guarded = "";
  let cursor = 0;

  for (const mention of mentions) {
    const allowed = verdicts.get(mention.clean.toLowerCase());
    const replacement = allowed ? mention.clean : defuseMention(mention.clean);

    if (!allowed) blocked.push(mention.clean);
    else if (replacement !== mention.source) repaired.push(mention.clean);

    if (replacement === mention.source) continue;

    guarded += text.slice(cursor, mention.index) + replacement;
    cursor = mention.index + mention.source.length;
  }

  if (blocked.length === 0 && repaired.length === 0) return text;

  guarded += text.slice(cursor);

  if (blocked.length > 0) {
    log?.warn?.(`[PING GUARD] Defused ${blocked.length} mention(s) outside ${org || "the org"}: ${blocked.join(", ")}`);
  }
  if (repaired.length > 0) {
    log?.info?.(`[PING GUARD] Repaired ${repaired.length} mention(s) GitHub would have mis-linked: ${repaired.join(", ")}`);
  }

  return guarded;
}

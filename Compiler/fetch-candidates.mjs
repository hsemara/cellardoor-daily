#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const compilerDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(compilerDir, "..");
const sourcesPath = resolve(compilerDir, "sources.json");
const outputDir = resolve(compilerDir, "output");

loadDotEnv(resolve(projectRoot, ".env"));

const token = process.env.X_BEARER_TOKEN?.trim();

if (!token || token === "replace_me") {
  console.error("Missing X_BEARER_TOKEN.");
  console.error("Copy .env.example to .env, paste your Bearer Token there, then run this again.");
  process.exit(1);
}

const sources = JSON.parse(readFileSync(sourcesPath, "utf8"));
const priorityMax = clampInteger(process.env.CELLARDOOR_SOURCE_PRIORITY_MAX, 1, 5, 2);
const lookbackHours = clampInteger(process.env.CELLARDOOR_LOOKBACK_HOURS, 1, 24 * 14, 72);
const maxAccounts = clampInteger(
  process.env.CELLARDOOR_MAX_ACCOUNTS,
  1,
  sources.dailyBudget?.maxAccountsPerRun || 30,
  20
);
const maxPostsPerAccount = clampInteger(
  process.env.CELLARDOOR_MAX_POSTS_PER_ACCOUNT,
  5,
  100,
  sources.defaults?.maxPostsPerAccountPerDay || 5
);
const maxPostsPerRun = clampInteger(
  process.env.CELLARDOOR_MAX_POSTS_PER_RUN,
  1,
  sources.dailyBudget?.maxPostsPerRun || 180,
  sources.dailyBudget?.maxPostsPerRun || 180
);

const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
const selectedAccounts = sources.accounts
  .filter((account) => account.priority <= priorityMax)
  .sort((a, b) => a.priority - b.priority || a.username.localeCompare(b.username))
  .slice(0, maxAccounts);

if (selectedAccounts.length === 0) {
  console.error(`No accounts found for priority <= ${priorityMax}.`);
  process.exit(1);
}

console.log(`Fetching candidate posts from ${selectedAccounts.length} curated X accounts.`);
console.log(`Priority <= ${priorityMax}, lookback ${lookbackHours} hours, max ${maxPostsPerAccount} posts/account.`);
console.log("");

const usersByUsername = await lookupUsers(selectedAccounts.map((account) => account.username));
const candidates = [];
const errors = [];

for (const account of selectedAccounts) {
  const user = usersByUsername.get(account.username.toLowerCase());

  if (!user) {
    errors.push({ username: account.username, reason: "User lookup did not resolve." });
    continue;
  }

  try {
    const timeline = await fetchUserPosts(user.id, maxPostsPerAccount);
    const posts = timeline.posts;
    const filtered = posts
      .map((post) => toCandidate(post, user, account, timeline.mediaByKey))
      .filter((candidate) => candidate.createdAt && new Date(candidate.createdAt) >= cutoff)
      .filter((candidate) => candidate.language === "en" || candidate.language === "und")
      .filter((candidate) => !containsBlockedTerm(candidate.text, sources.blockedTerms || []))
      .filter((candidate) => !isRepostOrReply(candidate));

    candidates.push(...filtered);
    console.log(`${account.displayName}: ${filtered.length}/${posts.length} candidates`);
  } catch (error) {
    errors.push({ username: account.username, reason: error.message });
    console.log(`${account.displayName}: failed (${error.message})`);
  }

  await delay(250);
}

const uniqueCandidates = dedupeById(candidates)
  .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  .slice(0, maxPostsPerRun);

const now = new Date();
const output = {
  generatedAt: now.toISOString(),
  source: {
    type: "x_curated_accounts",
    sourcesVersion: sources.version,
    priorityMax,
    lookbackHours,
    selectedAccounts: selectedAccounts.map((account) => ({
      username: account.username,
      displayName: account.displayName,
      group: account.group,
      organization: account.organization,
      priority: account.priority,
    })),
  },
  policy: {
    appAction: "read_only",
    storage: "local_private_candidate_intake",
    note: "Candidates may contain public X post text. Do not commit or redistribute raw candidate files.",
  },
  counts: {
    selectedAccounts: selectedAccounts.length,
    candidates: uniqueCandidates.length,
    errors: errors.length,
  },
  candidates: uniqueCandidates,
  errors,
};

mkdirSync(outputDir, { recursive: true });

const outputPath = resolve(outputDir, `candidates-${dateStamp(now)}.json`);
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log("");
console.log(`Wrote ${uniqueCandidates.length} candidates to ${relativeToProject(outputPath)}.`);

if (errors.length > 0) {
  console.log(`${errors.length} source errors were recorded in the output file.`);
}

async function lookupUsers(usernames) {
  const params = new URLSearchParams({
    usernames: usernames.join(","),
    "user.fields": "name,username,verified,verified_type",
  });
  const payload = await xGet(`/2/users/by?${params.toString()}`);
  const users = new Map();

  for (const user of payload.data || []) {
    users.set(user.username.toLowerCase(), user);
  }

  return users;
}

async function fetchUserPosts(userId, maxResults) {
  const params = new URLSearchParams({
    max_results: String(maxResults),
    "tweet.fields": "attachments,author_id,created_at,entities,lang,referenced_tweets",
    expansions: "attachments.media_keys",
    "media.fields": "alt_text,duration_ms,height,media_key,preview_image_url,type,url,width",
  });

  const excludes = [];

  if (!sources.defaults?.includeReplies) {
    excludes.push("replies");
  }

  if (!sources.defaults?.includeReposts) {
    excludes.push("retweets");
  }

  if (excludes.length > 0) {
    params.set("exclude", excludes.join(","));
  }

  const payload = await xGet(`/2/users/${userId}/tweets?${params.toString()}`);
  const mediaByKey = new Map(
    (payload.includes?.media || []).map((media) => [media.media_key, media])
  );

  return {
    posts: payload.data || [],
    mediaByKey,
  };
}

async function xGet(path) {
  const response = await fetch(`https://api.x.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "CellardoorCandidateCompiler/0.1",
    },
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`X API ${response.status} ${response.statusText}: ${summarizeBody(body)}`);
  }

  return JSON.parse(body);
}

function toCandidate(post, user, account, mediaByKey) {
  const username = user.username || account.username;
  const media = extractMedia(post, mediaByKey);

  return {
    id: post.id,
    url: `https://x.com/${username}/status/${post.id}`,
    createdAt: post.created_at || null,
    language: post.lang || "und",
    text: normalizeText(post.text),
    links: extractExpandedLinks(post),
    media,
    hasMedia: media.length > 0,
    hasVideo: media.some((item) => item.type === "video" || item.type === "animated_gif"),
    referencedTweets: post.referenced_tweets || [],
    sourceAccount: {
      username,
      displayName: account.displayName,
      organization: account.organization,
      group: account.group,
      priority: account.priority,
      why: account.why,
    },
    author: {
      id: user.id,
      username,
      name: user.name || account.displayName,
    },
  };
}

function containsBlockedTerm(text, blockedTerms) {
  const lowerText = text.toLowerCase();

  return blockedTerms.some((term) => lowerText.includes(String(term).toLowerCase()));
}

function isRepostOrReply(candidate) {
  return candidate.referencedTweets.some((reference) =>
    reference.type === "retweeted" || reference.type === "replied_to"
  );
}

function dedupeById(items) {
  const seen = new Set();
  const unique = [];

  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }

    seen.add(item.id);
    unique.push(item);
  }

  return unique;
}

function extractExpandedLinks(post) {
  return (post.entities?.urls || [])
    .map((url) => url.expanded_url || url.unwound_url || url.url)
    .filter(Boolean);
}

function extractMedia(post, mediaByKey) {
  return (post.attachments?.media_keys || [])
    .map((mediaKey) => mediaByKey.get(mediaKey))
    .filter(Boolean)
    .map((media) => ({
      mediaKey: media.media_key,
      type: media.type,
      url: media.url || null,
      previewImageUrl: media.preview_image_url || null,
      durationMs: media.duration_ms || null,
      width: media.width || null,
      height: media.height || null,
      altText: media.alt_text || null,
    }));
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function dateStamp(date) {
  return localDateStamp(date);
}

function localDateStamp(date) {
  const timeZone = process.env.CELLARDOOR_TIME_ZONE?.trim() || "America/Los_Angeles";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const partValue = (type) => parts.find((part) => part.type === type)?.value;

  return `${partValue("year")}-${partValue("month")}-${partValue("day")}`;
}

function relativeToProject(filePath) {
  return filePath.replace(`${projectRoot}/`, "");
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = stripOptionalQuotes(rawValue);
  }
}

function stripOptionalQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function summarizeBody(text) {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text.slice(0, 500);
  }
}

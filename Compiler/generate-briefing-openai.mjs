#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const compilerDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(compilerDir, "..");
const outputDir = resolve(compilerDir, "output");

loadDotEnv(resolve(projectRoot, ".env"));

const apiKey = process.env.OPENAI_API_KEY?.trim();

if (!apiKey || apiKey === "replace_me") {
  console.error("Missing OPENAI_API_KEY.");
  console.error("Add it to .env, then run this again. The key stays local and is not used by the iOS app.");
  process.exit(1);
}

const model = process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini";
const candidatePath = resolveCandidatePath();
const intake = JSON.parse(readFileSync(candidatePath, "utf8"));
const candidates = (intake.candidates || []).slice(0, 40);

if (candidates.length === 0) {
  console.error("No candidates found. Run `node Compiler/fetch-candidates.mjs` first.");
  process.exit(1);
}

const sourcePack = candidates.map((candidate) => ({
  id: candidate.id,
  url: candidate.url,
  createdAt: candidate.createdAt,
  text: candidate.text,
  links: candidate.links || [],
  author: {
    username: candidate.author.username,
    name: candidate.author.name,
  },
  media: {
    hasMedia: Boolean(candidate.hasMedia),
    hasVideo: Boolean(candidate.hasVideo),
    items: (candidate.media || []).map((media) => ({
      type: media.type,
      previewImageUrl: media.previewImageUrl,
      durationMs: media.durationMs,
    })),
  },
  sourceAccount: {
    displayName: candidate.sourceAccount.displayName,
    group: candidate.sourceAccount.group,
    organization: candidate.sourceAccount.organization,
    priority: candidate.sourceAccount.priority,
    why: candidate.sourceAccount.why,
  },
}));
const videoCandidates = sourcePack
  .filter((candidate) => candidate.media.hasVideo)
  .map((candidate) => ({
    id: candidate.id,
    url: candidate.url,
    authorUsername: candidate.author.username,
    authorName: candidate.author.name,
    mediaTypes: candidate.media.items.map((media) => media.type),
    textPreview: candidate.text.slice(0, 220),
  }));
const visualCandidates = sourcePack
  .filter((candidate) => candidate.media.hasMedia)
  .map((candidate) => ({
    id: candidate.id,
    url: candidate.url,
    authorUsername: candidate.author.username,
    authorName: candidate.author.name,
    mediaTypes: candidate.media.items.map((media) => media.type),
  }));
const sectionHints = buildSectionHints(sourcePack);

const generatedAt = new Date();

const response = await fetchWithRetry("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: systemPrompt(),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              appName: "Cellardoor",
              generatedAt: generatedAt.toISOString(),
              date: dateStamp(generatedAt),
              candidateGeneratedAt: intake.generatedAt,
              mediaSummary: {
                videoCandidates,
                visualCandidates,
              },
              sectionHints,
              candidates: sourcePack,
            }),
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "cellardoor_daily_briefing",
        strict: true,
        schema: dailyBriefingSchema(),
      },
    },
  }),
});

const responseBody = await response.text();

if (!response.ok) {
  console.error(`OpenAI request failed with ${response.status} ${response.statusText}.`);
  printJsonOrText(responseBody);
  process.exit(1);
}

const payload = JSON.parse(responseBody);
const outputText = extractOutputText(payload);

if (!outputText) {
  console.error("OpenAI response did not include output text.");
  printJsonOrText(responseBody);
  process.exit(1);
}

const briefing = JSON.parse(outputText);
ensureSectionCoverage(briefing, sourcePack);
ensureDetailVariants(briefing);
ensureKeywordArrays(briefing);

briefing.version = 1;
briefing.appName = "Cellardoor";
briefing.generatedAt = generatedAt.toISOString();
briefing.date = dateStamp(generatedAt);
briefing.source = {
  type: "openai_x_curated_daily_compiler",
  model,
  candidateFile: relativeToCompiler(candidatePath),
  candidateGeneratedAt: intake.generatedAt,
  inputCandidates: candidates.length,
  note: "Briefing items are AI-generated from curated public X candidates. Source post text is not included in this briefing file; links point back to X.",
};

const datedOutputPath = resolve(outputDir, `ai-briefing-${briefing.date}.json`);
const latestOutputPath = resolve(outputDir, "latest-briefing-ai.json");

writeFileSync(datedOutputPath, `${JSON.stringify(briefing, null, 2)}\n`, "utf8");
writeFileSync(latestOutputPath, `${JSON.stringify(briefing, null, 2)}\n`, "utf8");

console.log(`Read ${candidates.length} candidates from ${relativeToCompiler(candidatePath)}.`);
console.log(`Generated AI briefing with ${model}.`);
console.log(`Worth sections: ${briefing.sections.reduce((total, section) => total + section.items.length, 0)} items`);
console.log(`Discourse: ${briefing.discourse.items.length} items`);
console.log("");
console.log(`Wrote ${relativeToCompiler(datedOutputPath)}.`);
console.log(`Wrote ${relativeToCompiler(latestOutputPath)}.`);

function systemPrompt() {
  return [
    "You are the private daily editor for Cellardoor, a calm iPhone briefing app.",
    "Use only the provided public X candidate posts. Do not invent facts, sources, dates, claims, people, or links.",
    "Synthesize multiple posts into finite editorial briefing items when they belong together.",
    "Do not reproduce raw post text or quote posts. Paraphrase into calm, useful context.",
    "Link sourcePosts only to post IDs and URLs that appear in the input.",
    "Write in a human, warm, precise, non-hypey tone.",
    "Avoid urgency, doom, FOMO, social metrics, engagement language, or breaking-news framing.",
    "Preserve the product shape: a pull-based, finite note with Worth Knowing, Worth Reading, Worth Watching, optional Discourse, and a clear ending.",
    "Worth Knowing is for the day's main AI signals: product direction, model releases, open-source/public infrastructure, evaluation/governance, and major industry shifts. Produce 3 to 5 Worth Knowing items when the source material supports it.",
    "Worth Reading is for slower technical, research, evaluation, education, or thoughtful builder context. Produce 1 to 3 Worth Reading items when there are credible research/teaching/builder candidates. Use sectionHints.readingCandidates when provided.",
    "Worth Watching is for demos, prototypes, videos, visual/product examples, concrete interfaces, or posts with media that make an AI claim easier to inspect. Prefer candidates where media.hasVideo is true, but media.hasMedia is also acceptable when the post is visually useful. Use sectionHints.watchingCandidates when provided.",
    "If mediaSummary.videoCandidates is non-empty, you must include a Worth Watching section with at least one item, category demo, source.type demoClips, and sourcePosts containing the relevant video candidate post IDs/URLs.",
    "Worth Watching may be empty only when there are no video, media, demo, product interface, or credible visual candidates.",
    "The Discourse is for noisy, argumentative, speculative, or meta conversation that is useful background but not required. Use sectionHints.discourseCandidates when provided, and include 1 to 2 discourse items unless the source pack has no plausible discourse or framing material. Do not put solid open-source, governance, evaluation, education, or product signals in Discourse just because they are not launch news.",
    "Every non-empty section should have a clear, calm descriptor subtitle. Prefer this clarity over cleverness. Good examples: Worth Knowing: 'Key signals from today's AI conversation on X.' Worth Reading: 'Longer thread with technical context.' Worth Watching: 'Demos and videos that show the work in motion.' Discourse: 'Optional background from the louder parts of the conversation.'",
    "Use the completion title \"That's the shape of it.\" Keep the completion subtitle short, calm, and original. Do not quote or attribute named writers.",
    "Each item should synthesize 1 to 4 source posts. Prefer grouping related posts instead of making one card per post.",
    "Each item must include detailVariants with concise, standard, and detailed copy. Concise is one short sentence. Standard is the normal two-sentence Cellardoor card read. Detailed is a richer paragraph with more context, while staying calm and finite.",
    "The top-level summary and whyItMatters fields should match the standard detail variant exactly, so older app builds still behave correctly.",
    "Each item must include 3 to 12 lowercase keywords. Keep them short, concrete, and reusable across items, such as 'politics', 'policy', 'coding agents', 'developer tools', 'model releases', 'open source', 'infrastructure', 'research', 'evaluations', 'video', or 'product'.",
    "If the source material is thin, it is acceptable to have fewer items, but do not leave Worth Reading empty when there are useful slower-read candidates.",
    "The output must match the JSON schema exactly.",
  ].join(" ");
}

function buildSectionHints(sourceCandidates) {
  return {
    readingCandidates: readingSourceCandidates(sourceCandidates).slice(0, 8).map(candidateHint),
    watchingCandidates: watchingSourceCandidates(sourceCandidates).slice(0, 8).map(candidateHint),
    discourseCandidates: discourseSourceCandidates(sourceCandidates).slice(0, 8).map(candidateHint),
  };
}

function candidateHint(candidate) {
  return {
    id: candidate.id,
    url: candidate.url,
    authorUsername: candidate.author.username,
    authorName: candidate.author.name,
    sourceGroup: candidate.sourceAccount.group,
    mediaTypes: candidate.media.items.map((media) => media.type),
    linkCount: candidate.links.length,
    textPreview: candidate.text.slice(0, 220),
  };
}

function readingSourceCandidates(sourceCandidates) {
  return sourceCandidates
    .filter((candidate) =>
      candidate.links.length > 0 ||
      candidate.sourceAccount.group === "researchers_and_teachers" ||
      candidate.sourceAccount.group === "builders_and_tools"
    )
    .sort((a, b) => candidateSignalScore(b) - candidateSignalScore(a));
}

function watchingSourceCandidates(sourceCandidates) {
  return sourceCandidates
    .filter((candidate) =>
      candidate.media.hasMedia ||
      /demo|video|watch|prototype|interface|showing|try it|preview/i.test(candidate.text)
    )
    .sort((a, b) => candidateSignalScore(b) - candidateSignalScore(a));
}

function discourseSourceCandidates(sourceCandidates) {
  return sourceCandidates
    .filter((candidate) =>
      candidate.sourceAccount.group === "adoption_and_discourse" ||
      /argument|benchmark|debate|discourse|hype|opinion|policy|politic|risk|safety|speculat|take|wrong/i.test(candidate.text)
    )
    .sort((a, b) => candidateSignalScore(b) - candidateSignalScore(a));
}

function candidateSignalScore(candidate) {
  return [
    candidate.links.length > 0 ? 2 : 0,
    candidate.media.hasVideo ? 3 : 0,
    candidate.media.hasMedia ? 2 : 0,
    candidate.sourceAccount.priority ? 6 - candidate.sourceAccount.priority : 0,
  ].reduce((total, score) => total + score, 0);
}

function dailyBriefingSchema() {
  const sourcePost = {
    type: "object",
    additionalProperties: false,
    required: ["id", "url", "createdAt", "authorUsername", "authorName"],
    properties: {
      id: { type: "string" },
      url: { type: "string" },
      createdAt: { type: "string" },
      authorUsername: { type: "string" },
      authorName: { type: "string" },
    },
  };

  const item = {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "category",
      "title",
      "summary",
      "whyItMatters",
      "source",
      "detailVariants",
      "keywords",
      "readTimeMinutes",
      "sourcePosts",
      "isInitiallySaved",
    ],
    properties: {
      id: { type: "string" },
      category: {
        type: "string",
        enum: [
          "modelRelease",
          "research",
          "product",
          "infrastructure",
          "policy",
          "demo",
          "industrySignal",
          "discourse",
        ],
      },
      title: { type: "string" },
      summary: { type: "string" },
      whyItMatters: { type: "string" },
      source: {
        type: "object",
        additionalProperties: false,
        required: ["label", "type"],
        properties: {
          label: { type: "string" },
          type: {
            type: "string",
            enum: [
              "conversationCluster",
              "builderPosts",
              "researchThreads",
              "demoClips",
              "policyThreads",
              "designThreads",
              "discourseCluster",
            ],
          },
        },
      },
      detailVariants: {
        type: "object",
        additionalProperties: false,
        required: ["concise", "standard", "detailed"],
        properties: {
          concise: detailVariant(),
          standard: detailVariant(),
          detailed: detailVariant(),
        },
      },
      keywords: {
        type: "array",
        minItems: 3,
        maxItems: 12,
        items: { type: "string" },
      },
      readTimeMinutes: { type: "integer" },
      sourcePosts: {
        type: "array",
        items: sourcePost,
      },
      isInitiallySaved: { type: "boolean" },
    },
  };

  const section = {
    type: "object",
    additionalProperties: false,
    required: ["id", "title", "subtitle", "items"],
    properties: {
      id: {
        type: "string",
        enum: ["worth-knowing", "worth-reading", "worth-watching"],
      },
      title: { type: "string" },
      subtitle: { type: "string" },
      items: {
        type: "array",
        items: item,
      },
    },
  };

  return {
    type: "object",
    additionalProperties: false,
    required: [
      "version",
      "appName",
      "generatedAt",
      "date",
      "source",
      "orientation",
      "sections",
      "discourse",
      "completion",
    ],
    properties: {
      version: { type: "integer" },
      appName: { type: "string" },
      generatedAt: { type: "string" },
      date: { type: "string" },
      source: {
        type: "object",
        additionalProperties: false,
        required: ["type", "model", "candidateFile", "candidateGeneratedAt", "inputCandidates", "note"],
        properties: {
          type: { type: "string" },
          model: { type: "string" },
          candidateFile: { type: "string" },
          candidateGeneratedAt: { type: "string" },
          inputCandidates: { type: "integer" },
          note: { type: "string" },
        },
      },
      orientation: {
        type: "object",
        additionalProperties: false,
        required: ["greeting", "summary"],
        properties: {
          greeting: { type: "string" },
          summary: { type: "string" },
        },
      },
      sections: {
        type: "array",
        items: section,
      },
      discourse: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "subtitle", "items"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          subtitle: { type: "string" },
          items: {
            type: "array",
            items: item,
          },
        },
      },
      completion: {
        type: "object",
        additionalProperties: false,
        required: ["title", "subtitle"],
        properties: {
          title: { type: "string" },
          subtitle: { type: "string" },
        },
      },
    },
  };
}

function detailVariant() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "whyItMatters"],
    properties: {
      summary: { type: "string" },
      whyItMatters: { type: "string" },
    },
  };
}

function resolveCandidatePath() {
  if (process.env.CELLARDOOR_CANDIDATES_FILE) {
    return resolve(process.env.CELLARDOOR_CANDIDATES_FILE);
  }

  if (!existsSync(outputDir)) {
    console.error("No Compiler/output directory found. Run the candidate intake first.");
    process.exit(1);
  }

  const candidateFiles = readdirSync(outputDir)
    .filter((fileName) => fileName.startsWith("candidates-") && fileName.endsWith(".json"))
    .sort();

  if (candidateFiles.length === 0) {
    console.error("No candidates JSON file found in Compiler/output.");
    process.exit(1);
  }

  return resolve(outputDir, candidateFiles.at(-1));
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  const output = payload.output || [];
  const chunks = [];

  for (const item of output) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("");
}

function ensureSectionCoverage(briefing, sourceCandidates) {
  briefing.sections = Array.isArray(briefing.sections) ? briefing.sections : [];

  ensureWorthReadingSection(briefing, sourceCandidates);
  ensureWorthWatchingSection(briefing, sourceCandidates);
  ensureDiscourseSection(briefing, sourceCandidates);

  briefing.sections = sortSections(briefing.sections);
}

function ensureWorthReadingSection(briefing, sourceCandidates) {
  const candidates = readingSourceCandidates(sourceCandidates);

  if (candidates.length === 0) {
    return;
  }

  const worthReading = getOrCreateSection(briefing, {
    id: "worth-reading",
    title: "Worth Reading",
    subtitle: "Longer thread with technical context.",
  });

  if (worthReading.items.length > 0) {
    return;
  }

  const sourceCandidatesForItem = candidates.slice(0, 3);
  const authors = unique(sourceCandidatesForItem.map((candidate) => candidate.author.name));
  const summary = `${authorPhrase(authors)} shared source material that is better treated as slower technical context than as a headline. Save it for when you want the surrounding details behind today's signal.`;
  const whyItMatters = "Longer source threads and linked material are where the implementation tradeoffs usually show up. They help separate product framing from the underlying technical shape.";

  worthReading.items.push({
    id: `reading-context-${sourceCandidatesForItem.map((candidate) => candidate.id).join("-")}`,
    category: "research",
    title: "A longer thread adds useful technical context",
    summary,
    whyItMatters,
    source: {
      label: sourceCandidatesForItem.length === 1 ? `${sourceCandidatesForItem[0].author.name} on X` : "Research and builder posts on X",
      type: "researchThreads",
    },
    detailVariants: fallbackDetailVariants({ summary, whyItMatters }),
    keywords: ["technical context", "research", "builder posts", "source material"],
    readTimeMinutes: 4,
    sourcePosts: sourcePostsFromCandidates(sourceCandidatesForItem),
    isInitiallySaved: false,
  });
}

function ensureWorthWatchingSection(briefing, sourceCandidates) {
  const candidates = watchingSourceCandidates(sourceCandidates);

  if (candidates.length === 0) {
    return;
  }

  const worthWatching = getOrCreateSection(briefing, {
    id: "worth-watching",
    title: "Worth Watching",
    subtitle: "Demos and visual posts that show the work in motion.",
  });

  if (worthWatching.items.length > 0) {
    return;
  }

  const sourceCandidatesForItem = candidates.slice(0, 3);
  const authors = unique(sourceCandidatesForItem.map((candidate) => candidate.author.name));
  const hasVideo = sourceCandidatesForItem.some((candidate) => candidate.media.hasVideo);
  const summary = `${authorPhrase(authors)} shared ${hasVideo ? "a video-backed demo" : "a visual AI product example"} that gives the claim a more inspectable shape. It is worth a quick look because the interface says more than another abstract claim.`;
  const whyItMatters = "Visual evidence helps test whether a product idea has a real interaction pattern. Look for what the demo makes easier, not just what it promises.";

  worthWatching.items.push({
    id: `watching-demo-${sourceCandidatesForItem.map((candidate) => candidate.id).join("-")}`,
    category: "demo",
    title: hasVideo ? "A video-backed demo is worth a brief look" : "A visual example is worth a brief look",
    summary,
    whyItMatters,
    source: {
      label: sourceCandidatesForItem.length === 1 ? `${sourceCandidatesForItem[0].author.name} on X` : "Visual posts on X",
      type: "demoClips",
    },
    detailVariants: fallbackDetailVariants({ summary, whyItMatters }),
    keywords: ["video", "demos", "product", "interfaces"],
    readTimeMinutes: 2,
    sourcePosts: sourcePostsFromCandidates(sourceCandidatesForItem),
    isInitiallySaved: false,
  });
}

function ensureDiscourseSection(briefing, sourceCandidates) {
  const candidates = discourseSourceCandidates(sourceCandidates);
  const fallbackCandidates = candidates.length > 0 ? candidates : sourceCandidates.slice(0, 3);

  briefing.discourse = briefing.discourse || {
    id: "discourse",
    title: "The Discourse",
    subtitle: "Optional background from the louder parts of the conversation.",
    items: [],
  };
  briefing.discourse.items = Array.isArray(briefing.discourse.items) ? briefing.discourse.items : [];

  if (briefing.discourse.items.length > 0 || fallbackCandidates.length === 0) {
    return;
  }

  const sourceCandidatesForItem = fallbackCandidates.slice(0, 3);
  const authors = unique(sourceCandidatesForItem.map((candidate) => candidate.author.name));
  const summary = `${authorPhrase(authors)} helped shape the surrounding conversation on X, but this context is optional. Read it as background texture, not as something you need to chase.`;
  const whyItMatters = "Discourse can reveal how people are framing the same signal differently. Keeping it separate preserves the briefing's main shape while still making the surrounding noise legible.";

  briefing.discourse.items.push({
    id: `discourse-context-${sourceCandidatesForItem.map((candidate) => candidate.id).join("-")}`,
    category: "discourse",
    title: "The surrounding conversation is worth keeping optional",
    summary,
    whyItMatters,
    source: {
      label: sourceCandidatesForItem.length === 1 ? `${sourceCandidatesForItem[0].author.name} on X` : "Conversation context on X",
      type: "discourseCluster",
    },
    detailVariants: fallbackDetailVariants({ summary, whyItMatters }),
    keywords: ["discourse", "context", "x conversation", "framing"],
    readTimeMinutes: 2,
    sourcePosts: sourcePostsFromCandidates(sourceCandidatesForItem),
    isInitiallySaved: false,
  });
}

function getOrCreateSection(briefing, defaults) {
  let section = briefing.sections.find((candidate) => candidate.id === defaults.id);

  if (!section) {
    section = {
      ...defaults,
      items: [],
    };
    briefing.sections.push(section);
  }

  section.title = section.title || defaults.title;
  section.subtitle = section.subtitle || defaults.subtitle;
  section.items = Array.isArray(section.items) ? section.items : [];

  return section;
}

function sortSections(sections) {
  const order = ["worth-knowing", "worth-reading", "worth-watching"];

  return [...sections].sort((a, b) => {
    const aIndex = order.indexOf(a.id);
    const bIndex = order.indexOf(b.id);
    return (aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex) -
      (bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex);
  });
}

function sourcePostsFromCandidates(candidates) {
  return candidates.map((candidate) => ({
    id: candidate.id,
    url: candidate.url,
    createdAt: candidate.createdAt,
    authorUsername: candidate.author.username,
    authorName: candidate.author.name,
  }));
}

function ensureDetailVariants(briefing) {
  for (const item of allBriefingItems(briefing)) {
    if (hasCompleteDetailVariants(item)) {
      item.summary = item.detailVariants.standard.summary;
      item.whyItMatters = item.detailVariants.standard.whyItMatters;
      continue;
    }

    item.detailVariants = fallbackDetailVariants(item);
  }
}

function hasCompleteDetailVariants(item) {
  return ["concise", "standard", "detailed"].every((level) =>
    item.detailVariants?.[level]?.summary &&
    item.detailVariants?.[level]?.whyItMatters
  );
}

function fallbackDetailVariants(item) {
  const standardSummary = item.summary || "";
  const standardWhy = item.whyItMatters || "";

  return {
    concise: {
      summary: firstSentence(standardSummary),
      whyItMatters: firstSentence(standardWhy),
    },
    standard: {
      summary: standardSummary,
      whyItMatters: standardWhy,
    },
    detailed: {
      summary: `${standardSummary} The useful read is to place this alongside the surrounding source posts, rather than treating it as a standalone headline.`,
      whyItMatters: `${standardWhy} This is most useful when it clarifies direction, incentives, or product behavior.`,
    },
  };
}

function firstSentence(text) {
  const match = String(text).match(/^.*?[.!?](?:\s|$)/);
  return (match ? match[0] : text).trim();
}

function ensureKeywordArrays(briefing) {
  for (const item of allBriefingItems(briefing)) {
    if (Array.isArray(item.keywords) && item.keywords.length > 0) {
      item.keywords = normalizeKeywords(item.keywords);
      continue;
    }

    item.keywords = fallbackKeywordsFor(item);
  }
}

function allBriefingItems(briefing) {
  return [
    ...(briefing.sections || []).flatMap((section) => section.items || []),
    ...((briefing.discourse && briefing.discourse.items) || []),
  ];
}

function normalizeKeywords(keywords) {
  return unique(
    keywords
      .map((keyword) => String(keyword).trim().toLowerCase())
      .filter(Boolean)
  ).slice(0, 12);
}

function fallbackKeywordsFor(item) {
  const base = {
    modelRelease: ["model releases", "product", "launches"],
    research: ["research", "evaluations", "technical context"],
    product: ["product", "developer tools", "workflow"],
    infrastructure: ["infrastructure", "developer tools", "agents"],
    policy: ["policy", "governance", "politics"],
    demo: ["video", "demos", "interfaces"],
    industrySignal: ["industry signal", "ecosystem", "governance"],
    discourse: ["discourse", "context", "x conversation"],
  };

  return base[item.category] || ["ai", "x conversation", "context"];
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function authorPhrase(authors) {
  if (authors.length === 0) {
    return "A curated source";
  }

  if (authors.length === 1) {
    return authors[0];
  }

  if (authors.length === 2) {
    return `${authors[0]} and ${authors[1]}`;
  }

  return `${authors.slice(0, -1).join(", ")}, and ${authors.at(-1)}`;
}

async function fetchWithRetry(url, options, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      if (attempt < attempts) {
        console.log(`OpenAI request attempt ${attempt} failed; retrying...`);
        await delay(1_500 * attempt);
      }
    }
  }

  throw lastError;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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

function relativeToCompiler(filePath) {
  return filePath.replace(`${compilerDir}/`, "");
}

function printJsonOrText(text) {
  try {
    console.error(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.error(text);
  }
}

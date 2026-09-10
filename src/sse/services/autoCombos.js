import { getProviderConnections } from "@/lib/localDb";
import REGISTRY from "open-sse/providers/registry/index.js";
import { PROVIDER_MODELS } from "open-sse/providers/index.js";
import { modelKind } from "open-sse/providers/models/schema.js";

// Virtual combo aliases. They are resolved at request time from the providers
// currently configured in 9Router, so adding/removing a provider automatically
// changes the candidate pool without requiring a database combo entry.
export const AUTO_ALIASES = new Set([
  "auto",
  "free-auto",
  "bestcoding-auto",
  "bestreasoning-auto",
  "bestchat-auto",
  "bestcodingfast",
]);

const CACHE_TTL_MS = 30_000;
const MAX_CANDIDATES = 8;
let cache = { at: 0, value: null };

const registryById = new Map(REGISTRY.map((entry) => [entry.id, entry]));
const providerIdByAlias = new Map(
  REGISTRY.map((entry) => [entry.alias || entry.id, entry.id])
);

function normalizeProviderId(aliasOrId) {
  return providerIdByAlias.get(aliasOrId) || aliasOrId;
}

function modelText(entry) {
  return `${entry.model.id} ${entry.model.name || ""}`.toLowerCase();
}

function scoreModel(entry, kind) {
  const text = modelText(entry);
  let score = 0;

  if (kind === "coding") {
    if (/codex|coder|coding|code|dev|codestral/.test(text)) score += 80;
    if (/sonnet|opus|deepseek|qwen|kimi|grok/.test(text)) score += 20;
    if (/reason|thinking|thought|r1/.test(text)) score += 10;
    if (/mini|flash|lite|small|haiku/.test(text)) score -= 5;
  } else if (kind === "reasoning") {
    if (/reason|thinking|thought|r1|o1|o3|o4/.test(text)) score += 80;
    if (/opus|pro/.test(text)) score += 30;
    if (/mini|flash|lite|small|haiku/.test(text)) score -= 8;
  } else if (kind === "fast") {
    if (/flash|mini|haiku|small|lite|fast|spark/.test(text)) score += 55;
    if (/codex|coder|coding/.test(text)) score += 15;
    if (/opus|pro|70b|120b|405b/.test(text)) score -= 15;
  } else {
    // General auto: prefer strong general-purpose models while avoiding
    // obviously tiny/embedding/media entries.
    if (/gpt|claude|gemini|grok|qwen|kimi|deepseek|glm|minimax|mistral|llama/.test(text)) score += 30;
    if (/opus|sonnet|pro|codex/.test(text)) score += 20;
    if (/mini|flash|lite|small|haiku/.test(text)) score += 5;
  }

  if (/preview|deprecated|legacy/.test(text)) score -= 8;
  if (entry.model.kind === "embedding" || entry.model.kind === "image") score -= 1000;

  // Stable tie-breaker: provider priority is applied separately, then model id.
  score += Math.min(Number(entry.provider.priority) || 0, 20) / 100;
  return score;
}

function isFree(entry) {
  const provider = entry.provider;
  const model = entry.model;
  return Boolean(
    provider.category === "free" ||
    /(^|[-_:/.])free($|[-_:/.])/i.test(model.id) ||
    /\bfree\b/i.test(model.name || "")
  );
}

function collectEntries(configuredProviderIds) {
  const entries = [];

  for (const [aliasOrId, models] of Object.entries(PROVIDER_MODELS)) {
    const providerId = normalizeProviderId(aliasOrId);
    const provider = registryById.get(providerId);
    if (!provider || provider.display?.deprecated || !configuredProviderIds.has(providerId) || !Array.isArray(models)) continue;

    for (const model of models) {
      if (!model?.id || modelKind(model) !== "llm") continue;
      entries.push({ provider, providerId, aliasOrId, model });
    }
  }

  return entries;
}

function dedupeAndRank(entries, kind, freeOnly) {
  const pool = freeOnly ? entries.filter(isFree) : entries;
  const seen = new Set();

  return pool
    .map((entry) => ({ entry, score: scoreModel(entry, kind) }))
    .filter(({ entry }) => {
      const key = `${entry.providerId}/${entry.model.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const priorityDiff = (Number(b.entry.provider.priority) || 0) - (Number(a.entry.provider.priority) || 0);
      if (priorityDiff !== 0) return priorityDiff;
      return `${a.entry.providerId}/${a.entry.model.id}`.localeCompare(`${b.entry.providerId}/${b.entry.model.id}`);
    })
    .slice(0, MAX_CANDIDATES)
    .map(({ entry }) => `${entry.aliasOrId}/${entry.model.id}`);
}

async function buildAutoCombos() {
  const connections = await getProviderConnections({ isActive: true });
  const configuredProviderIds = new Set(
    connections.map((connection) => normalizeProviderId(connection.provider))
  );
  const entries = collectEntries(configuredProviderIds);

  return {
    auto: dedupeAndRank(entries, "chat", false),
    "free-auto": dedupeAndRank(entries, "chat", true),
    "bestcoding-auto": dedupeAndRank(entries, "coding", false),
    "bestreasoning-auto": dedupeAndRank(entries, "reasoning", false),
    "bestchat-auto": dedupeAndRank(entries, "chat", false),
    bestcodingfast: dedupeAndRank(entries, "fast", false),
  };
}

export function isAutoCombo(modelStr) {
  return AUTO_ALIASES.has(modelStr);
}

export async function getAutoComboModels(modelStr) {
  if (!isAutoCombo(modelStr)) return null;

  const now = Date.now();
  if (!cache.value || now - cache.at >= CACHE_TTL_MS) {
    cache = { at: now, value: await buildAutoCombos() };
  }

  const models = cache.value[modelStr] || [];
  return models.length ? models : null;
}

// Useful after credentials/provider configuration changes. The next request
// will rebuild the virtual combos instead of using the short-lived cache.
export function invalidateAutoComboCache() {
  cache = { at: 0, value: null };
}

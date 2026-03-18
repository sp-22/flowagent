import { DEFAULT_SETTINGS, ITEM_STATUS } from "./constants.js";
import { filterProviderModels, getActiveLlmAccount, getProviderPreset } from "./llm-providers.js";

function normalizeModelList(providerId, models = [], fallbackModel = "") {
  const normalized = filterProviderModels(providerId, models);
  const safeFallback = filterProviderModels(providerId, [fallbackModel])[0];
  if (safeFallback && !normalized.includes(safeFallback)) {
    normalized.unshift(safeFallback);
  }
  return normalized.slice(0, 200);
}

function normalizeLlmAccount(account = {}, index = 0) {
  const preset = getProviderPreset(account.providerId || account.llmProvider || DEFAULT_SETTINGS.llmProvider);
  const selectedModel = filterProviderModels(
    preset.id,
    [account.selectedModel || account.model || preset.defaultModel]
  )[0] || preset.defaultModel;
  const availableModels = normalizeModelList(preset.id, account.availableModels, selectedModel);
  return {
    id: String(account.id || `llm-account-${index + 1}`).trim(),
    providerId: preset.id,
    label: String(account.label || `${preset.label} ${index + 1}`).trim(),
    apiKey: String(account.apiKey || "").trim(),
    apiBaseUrl: String(account.apiBaseUrl || preset.defaultBaseUrl).trim(),
    selectedModel,
    availableModels,
    lastModelSyncAt: Number(account.lastModelSyncAt) || null,
    lastSyncError: String(account.lastSyncError || "").trim()
  };
}

export function randomInt(min, max) {
  const safeMin = Math.ceil(Number(min) || 0);
  const safeMax = Math.floor(Number(max) || safeMin);
  return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
}

export function clampRange(range, fallback) {
  const min = Number(range?.min);
  const max = Number(range?.max);
  const fallbackMin = fallback.min;
  const fallbackMax = fallback.max;
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: fallbackMin, max: fallbackMax };
  }
  return {
    min: Math.max(0, Math.min(min, max)),
    max: Math.max(min, max)
  };
}

export function pickDailyTarget(range) {
  const safe = clampRange(range, DEFAULT_SETTINGS.dailyTargetRange);
  return randomInt(safe.min, safe.max);
}

export function getLocalDateKey(timestamp = Date.now()) {
  const now = new Date(timestamp);
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createId(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeQueries(rawQueries) {
  if (Array.isArray(rawQueries)) {
    return rawQueries.map((query) => query.trim()).filter(Boolean);
  }

  return String(rawQueries || "")
    .split(/\r?\n/)
    .map((query) => query.trim())
    .filter(Boolean);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldSkipWithChance(chance = 0) {
  return Math.random() < Math.max(0, Math.min(1, Number(chance) || 0));
}

export function boundedArray(items, limit) {
  return items.slice(Math.max(0, items.length - limit));
}

export function getRemainingTarget(stats, pickedTarget) {
  if (!pickedTarget) {
    return 0;
  }

  return Math.max(0, pickedTarget - (stats?.posted || 0));
}

export function normalizeSettings(rawSettings = {}) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...rawSettings
  };
  const legacyProviderPreset = getProviderPreset(merged.llmProvider);
  const llmAccounts = Array.isArray(merged.llmAccounts) && merged.llmAccounts.length
    ? merged.llmAccounts.map((account, index) => normalizeLlmAccount(account, index))
    : (String(merged.apiKey || "").trim()
        ? [normalizeLlmAccount({
          id: "legacy-account",
          providerId: merged.llmProvider || legacyProviderPreset.id,
          label: `${legacyProviderPreset.label} legacy`,
          apiKey: merged.apiKey,
          apiBaseUrl: merged.apiBaseUrl,
          selectedModel: merged.model
        }, 0)]
        : []);

  const activeAccount = getActiveLlmAccount({
    ...merged,
    llmAccounts,
    activeLlmAccountId: merged.activeLlmAccountId
  }) || llmAccounts[0] || null;
  const providerPreset = getProviderPreset(activeAccount?.providerId || merged.llmProvider);

  return {
    ...merged,
    queries: normalizeQueries(merged.queries),
    platforms: Array.isArray(merged.platforms) && merged.platforms.length
      ? [...new Set(merged.platforms)]
      : [...DEFAULT_SETTINGS.platforms],
    dailyTargetRange: clampRange(merged.dailyTargetRange, DEFAULT_SETTINGS.dailyTargetRange),
    readingDelayRangeMs: clampRange(merged.readingDelayRangeMs, DEFAULT_SETTINGS.readingDelayRangeMs),
    betweenDelayRangeMs: clampRange(merged.betweenDelayRangeMs, DEFAULT_SETTINGS.betweenDelayRangeMs),
    typingDelayRangeMs: clampRange(merged.typingDelayRangeMs, DEFAULT_SETTINGS.typingDelayRangeMs),
    tone: merged.tone || DEFAULT_SETTINGS.tone,
    insertionMode: merged.insertionMode || DEFAULT_SETTINGS.insertionMode,
    skipChance: Math.max(0, Math.min(0.75, Number(merged.skipChance) || DEFAULT_SETTINGS.skipChance)),
    llmAccounts,
    activeLlmAccountId: activeAccount?.id || null,
    llmProvider: activeAccount?.providerId || providerPreset.id,
    model: String(activeAccount?.selectedModel || merged.model || providerPreset.defaultModel).trim(),
    apiBaseUrl: String(activeAccount?.apiBaseUrl || merged.apiBaseUrl || providerPreset.defaultBaseUrl).trim(),
    customPromptSuffix: String(merged.customPromptSuffix || "").trim(),
    apiKey: String(activeAccount?.apiKey || merged.apiKey || "").trim(),
    maxOutputTokens: Math.max(64, Number(merged.maxOutputTokens) || DEFAULT_SETTINGS.maxOutputTokens)
  };
}

export function isTerminalItemStatus(status) {
  return [ITEM_STATUS.POSTED, ITEM_STATUS.SKIPPED, ITEM_STATUS.FAILED].includes(status);
}

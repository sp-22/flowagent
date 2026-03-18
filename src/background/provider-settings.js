import { filterProviderModels, getProviderFallbackModels, getProviderPreset } from "../shared/llm-providers.js";
import { createId, normalizeSettings } from "../shared/utils.js";
import { getSettings, saveSettings } from "./storage.js";

function uniqueModels(providerId, models = [], fallbackModel = "") {
  const next = filterProviderModels(providerId, models);
  const safeFallback = filterProviderModels(providerId, [fallbackModel])[0];
  if (safeFallback && !next.includes(safeFallback)) {
    next.unshift(safeFallback);
  }
  return next.slice(0, 200);
}

function sortModels(models = []) {
  return [...new Set(models)].sort((left, right) => left.localeCompare(right));
}

function mapProviderModels(providerId, json) {
  switch (providerId) {
    case "openai":
    case "nvidia":
      return sortModels((json?.data || [])
        .map((item) => item?.id || "")
        .filter(Boolean));
    case "gemini":
      return sortModels((json?.models || [])
        .map((item) => String(item?.name || "").replace(/^models\//, ""))
        .filter(Boolean));
    case "claude":
      return sortModels((json?.data || json?.models || [])
        .map((item) => item?.id || item?.name || "")
        .filter(Boolean));
    default:
      return [];
  }
}

async function fetchJson(url, options, providerLabel) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${providerLabel} model fetch failed (${response.status}): ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function fetchProviderModelsForAccount(account) {
  const preset = getProviderPreset(account.providerId);
  const baseUrl = String(account.apiBaseUrl || preset.defaultBaseUrl).replace(/\/$/, "");
  switch (account.providerId) {
    case "openai":
    case "nvidia": {
      const json = await fetchJson(`${baseUrl}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${account.apiKey}`
        }
      }, preset.label);
      return mapProviderModels(account.providerId, json);
    }
    case "gemini": {
      const json = await fetchJson(`${baseUrl}/models`, {
        method: "GET",
        headers: {
          "x-goog-api-key": account.apiKey
        }
      }, preset.label);
      return mapProviderModels(account.providerId, json);
    }
    case "claude": {
      const json = await fetchJson(`${baseUrl}/v1/models`, {
        method: "GET",
        headers: {
          "x-api-key": account.apiKey,
          "anthropic-version": "2023-06-01"
        }
      }, preset.label);
      return mapProviderModels(account.providerId, json);
    }
    default:
      return [];
  }
}

function normalizeIncomingAccount(account) {
  const preset = getProviderPreset(account.providerId);
  const selectedModel = filterProviderModels(
    preset.id,
    [account.selectedModel || preset.defaultModel]
  )[0] || preset.defaultModel;
  return {
    id: String(account.id || createId("llm")).trim(),
    providerId: preset.id,
    label: String(account.label || preset.label).trim(),
    apiKey: String(account.apiKey || "").trim(),
    apiBaseUrl: String(account.apiBaseUrl || preset.defaultBaseUrl).trim(),
    selectedModel,
    availableModels: uniqueModels(preset.id, account.availableModels, selectedModel),
    lastModelSyncAt: Number(account.lastModelSyncAt) || null,
    lastSyncError: String(account.lastSyncError || "").trim()
  };
}

export async function upsertLlmAccount(account) {
  const settings = await getSettings();
  const normalizedAccount = normalizeIncomingAccount(account || {});
  const nextAccounts = [
    normalizedAccount,
    ...(settings.llmAccounts || []).filter((item) => item.id !== normalizedAccount.id)
  ];
  const nextSettings = await saveSettings({
    ...settings,
    llmAccounts: nextAccounts,
    activeLlmAccountId: settings.activeLlmAccountId || normalizedAccount.id
  });
  return normalizeSettings(nextSettings);
}

export async function deleteLlmAccount(accountId) {
  const settings = await getSettings();
  const nextAccounts = (settings.llmAccounts || []).filter((account) => account.id !== accountId);
  const nextSettings = await saveSettings({
    ...settings,
    llmAccounts: nextAccounts,
    activeLlmAccountId: settings.activeLlmAccountId === accountId
      ? nextAccounts[0]?.id || null
      : settings.activeLlmAccountId
  });
  return normalizeSettings(nextSettings);
}

export async function setActiveLlmAccount(accountId) {
  const settings = await getSettings();
  const nextSettings = await saveSettings({
    ...settings,
    activeLlmAccountId: accountId
  });
  return normalizeSettings(nextSettings);
}

export async function selectModelForAccount({ accountId, model }) {
  const settings = await getSettings();
  const nextAccounts = (settings.llmAccounts || []).map((account) => {
    if (account.id !== accountId) {
      return account;
    }
    return {
      ...account,
      selectedModel: filterProviderModels(account.providerId, [model])[0] || account.selectedModel,
      availableModels: uniqueModels(account.providerId, account.availableModels, model || account.selectedModel)
    };
  });
  const nextSettings = await saveSettings({
    ...settings,
    llmAccounts: nextAccounts,
    activeLlmAccountId: settings.activeLlmAccountId || accountId
  });
  return normalizeSettings(nextSettings);
}

export async function refreshAccountModels(accountId) {
  const settings = await getSettings();
  const account = (settings.llmAccounts || []).find((item) => item.id === accountId);
  if (!account) {
    throw new Error("Account not found.");
  }
  if (!account.apiKey) {
    throw new Error("Add an API key before refreshing models.");
  }

  const fallbackModels = getProviderFallbackModels(account.providerId);
  const safeFallbackModels = uniqueModels(account.providerId, fallbackModels, account.selectedModel);
  try {
    const fetchedModels = await fetchProviderModelsForAccount(account);
    const models = uniqueModels(account.providerId, fetchedModels, account.selectedModel || fallbackModels[0] || "");
    const nextAccounts = (settings.llmAccounts || []).map((item) => {
      if (item.id !== accountId) {
        return item;
      }
      return {
        ...item,
        availableModels: models.length ? models : safeFallbackModels,
        selectedModel: models.includes(item.selectedModel)
          ? item.selectedModel
          : (models[0] || safeFallbackModels[0] || getProviderPreset(account.providerId).defaultModel),
        lastModelSyncAt: Date.now(),
        lastSyncError: ""
      };
    });
    return saveSettings({
      ...settings,
      llmAccounts: nextAccounts
    });
  } catch (error) {
    const nextAccounts = (settings.llmAccounts || []).map((item) => {
      if (item.id !== accountId) {
        return item;
      }
      return {
        ...item,
        availableModels: uniqueModels(item.providerId, item.availableModels, item.selectedModel || fallbackModels[0] || ""),
        selectedModel: filterProviderModels(item.providerId, [item.selectedModel])[0]
          || uniqueModels(item.providerId, item.availableModels, item.selectedModel || fallbackModels[0] || "")[0]
          || getProviderPreset(item.providerId).defaultModel,
        lastSyncError: error.message,
        lastModelSyncAt: item.lastModelSyncAt || null
      };
    });
    await saveSettings({
      ...settings,
      llmAccounts: nextAccounts
    });
    throw error;
  }
}

export async function saveAgentSettings(patch = {}) {
  const settings = await getSettings();
  return saveSettings({
    ...settings,
    customPromptSuffix: patch.customPromptSuffix ?? settings.customPromptSuffix,
    maxOutputTokens: patch.maxOutputTokens ?? settings.maxOutputTokens
  });
}

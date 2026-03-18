import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_NVIDIA_MODEL,
  DEFAULT_OPENAI_MODEL,
  LLM_PROVIDER_IDS
} from "./constants.js";

export const LLM_PROVIDERS = {
  [LLM_PROVIDER_IDS.OPENAI]: {
    id: LLM_PROVIDER_IDS.OPENAI,
    label: "OpenAI",
    kind: "openai-responses",
    defaultModel: DEFAULT_OPENAI_MODEL,
    defaultBaseUrl: "https://api.openai.com/v1"
  },
  [LLM_PROVIDER_IDS.GEMINI]: {
    id: LLM_PROVIDER_IDS.GEMINI,
    label: "Google Gemini",
    kind: "gemini-generate-content",
    defaultModel: DEFAULT_GEMINI_MODEL,
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta"
  },
  [LLM_PROVIDER_IDS.NVIDIA]: {
    id: LLM_PROVIDER_IDS.NVIDIA,
    label: "NVIDIA",
    kind: "openai-chat",
    defaultModel: DEFAULT_NVIDIA_MODEL,
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1"
  },
  [LLM_PROVIDER_IDS.CLAUDE]: {
    id: LLM_PROVIDER_IDS.CLAUDE,
    label: "Claude",
    kind: "anthropic-messages",
    defaultModel: DEFAULT_CLAUDE_MODEL,
    defaultBaseUrl: "https://api.anthropic.com"
  }
};

const FALLBACK_MODELS = {
  [LLM_PROVIDER_IDS.OPENAI]: [
    "gpt-5",
    "gpt-5-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o-mini"
  ],
  [LLM_PROVIDER_IDS.GEMINI]: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash"
  ],
  [LLM_PROVIDER_IDS.NVIDIA]: [
    "meta/llama-3.1-8b-instruct",
    "meta/llama-3.1-70b-instruct",
    "mistralai/mixtral-8x7b-instruct-v0.1"
  ],
  [LLM_PROVIDER_IDS.CLAUDE]: [
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-3-7-sonnet-20250219",
    "claude-3-5-haiku-20241022"
  ]
};

const NON_LLM_MODEL_PATTERNS = [
  /embed/i,
  /embedding/i,
  /rerank/i,
  /moderation/i,
  /dall[- ]?e/i,
  /gpt-image/i,
  /image/i,
  /vision/i,
  /whisper/i,
  /tts/i,
  /speech/i,
  /transcrib/i,
  /audio/i,
  /sdxl/i,
  /stable[- ]?diffusion/i,
  /segment/i,
  /ocr/i,
  /veo/i,
  /imagen/i,
  /aqa/i,
  /learnlm/i,
  /parakeet/i,
  /canary/i,
  /neva/i
];

const PROVIDER_LLM_ALLOW_PATTERNS = {
  [LLM_PROVIDER_IDS.OPENAI]: [
    /^gpt-/i,
    /^o[134][-_0-9a-z.]*$/i,
    /^chatgpt-/i,
    /computer-use-preview/i
  ],
  [LLM_PROVIDER_IDS.GEMINI]: [
    /^gemini/i
  ],
  [LLM_PROVIDER_IDS.NVIDIA]: [
    /(^|\/)(llama|nemotron|mistral|mixtral|qwen|phi|deepseek|gemma|command-r|jamba|ministral|exaone|granite|solar|aya|falcon|olmo|dbrx|yi|glm|vicuna|wizardlm|zephyr|nemo|openchat|smollm)/i
  ],
  [LLM_PROVIDER_IDS.CLAUDE]: [
    /^claude/i
  ]
};

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function getProviderPreset(providerId) {
  return LLM_PROVIDERS[providerId] || LLM_PROVIDERS[LLM_PROVIDER_IDS.OPENAI];
}

export function getProviderFallbackModels(providerId) {
  return FALLBACK_MODELS[providerId] || [];
}

export function isSupportedLlmModel(providerId, model) {
  const safeModel = String(model || "").trim();
  if (!safeModel) {
    return false;
  }
  if (NON_LLM_MODEL_PATTERNS.some((pattern) => pattern.test(safeModel))) {
    return false;
  }
  const allowPatterns = PROVIDER_LLM_ALLOW_PATTERNS[providerId] || [];
  if (!allowPatterns.length) {
    return true;
  }
  return allowPatterns.some((pattern) => pattern.test(safeModel));
}

export function filterProviderModels(providerId, models = []) {
  return uniqueStrings(models).filter((model) => isSupportedLlmModel(providerId, model));
}

export function getActiveLlmAccount(settings = {}) {
  const accounts = Array.isArray(settings.llmAccounts) ? settings.llmAccounts : [];
  const activeId = String(settings.activeLlmAccountId || "").trim();
  return accounts.find((account) => account.id === activeId) || accounts[0] || null;
}

export function resolveProviderConfig(settings) {
  const account = getActiveLlmAccount(settings);
  const preset = getProviderPreset(account?.providerId || settings?.llmProvider);
  const availableModels = filterProviderModels(
    preset.id,
    Array.isArray(account?.availableModels) && account.availableModels.length
      ? account.availableModels
      : getProviderFallbackModels(preset.id)
  );
  const model = filterProviderModels(preset.id, [
    account?.selectedModel || settings?.model || preset.defaultModel
  ])[0] || availableModels[0] || preset.defaultModel;
  return {
    ...preset,
    accountId: account?.id || null,
    accountLabel: account?.label || preset.label,
    model,
    baseUrl: String(account?.apiBaseUrl || settings?.apiBaseUrl || preset.defaultBaseUrl).trim(),
    apiKey: String(account?.apiKey || settings?.apiKey || "").trim(),
    availableModels,
    maxOutputTokens: Number(settings?.maxOutputTokens) || 300
  };
}

import {
  APPROVAL_MODES,
  CHAT_MESSAGE_TYPES,
  DEFAULT_USER_MEMORY,
  FAILURE_MODES,
  WORKFLOW_PLAN_STATUS,
  WORKFLOW_STEP_KINDS
} from "./constants.js";
import { createId } from "./utils.js";

const RISKY_ACTION_PATTERN = /\b(submit|publish|post|send|delete|remove|purchase|buy|checkout|confirm|save changes|place order|logout|sign out|disconnect|disable|close account)\b/i;

function toText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function normalizeKey(value, fallback = "") {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeOrigin(origin) {
  try {
    const parsed = new URL(origin);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return "";
    }
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}/*`;
  } catch {
    return "";
  }
}

export function createChatMessage(type, content, data = {}) {
  return {
    id: createId("chat"),
    type,
    content: String(content || "").trim(),
    data,
    timestamp: Date.now()
  };
}

export function extractDomainsFromText(text) {
  const domains = new Set();
  const matches = String(text || "").match(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,})(?:\/[^\s]*)?/gi) || [];
  for (const match of matches) {
    const normalized = match.startsWith("http") ? match : `https://${match}`;
    try {
      const parsed = new URL(normalized);
      domains.add(parsed.hostname.replace(/^www\./i, ""));
    } catch {
      // Ignore unparseable text.
    }
  }
  return [...domains];
}

export function extractRequiredOrigins(steps = []) {
  const origins = new Set();
  for (const step of steps) {
    if (step?.kind !== "open_url") {
      continue;
    }
    const origin = normalizeOrigin(step?.args?.url);
    if (origin) {
      origins.add(origin);
    }
  }
  return [...origins];
}

export function isRiskyStep(step = {}) {
  if (!["click", "type"].includes(step.kind)) {
    return false;
  }
  const haystack = [
    step.label,
    step.args?.selector,
    step.args?.text,
    step.args?.targetText,
    step.args?.label,
    step.args?.placeholder,
    step.args?.purpose,
    step.args?.description
  ].map(toText).join(" ");
  return RISKY_ACTION_PATTERN.test(haystack);
}

export function isDomStep(step = {}) {
  return [
    "click",
    "type",
    "select_option",
    "wait_for",
    "extract_text",
    "extract_list",
    "scroll"
  ].includes(step.kind);
}

export function resolveTemplateVariables(value, outputs = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateVariables(item, outputs));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveTemplateVariables(item, outputs)])
    );
  }

  if (typeof value !== "string") {
    return value;
  }

  const exactMatch = value.match(/^{{\s*([\w.-]+)\s*}}$/);
  if (exactMatch) {
    return outputs[exactMatch[1]];
  }

  return value.replace(/{{\s*([\w.-]+)\s*}}/g, (_match, key) => {
    const resolved = outputs[key];
    if (typeof resolved === "string") {
      return resolved;
    }
    if (resolved == null) {
      return "";
    }
    try {
      return JSON.stringify(resolved);
    } catch {
      return String(resolved);
    }
  });
}

export function buildSelectorMemoryKey(step = {}) {
  return normalizeKey(step?.args?.purpose || step?.label || step?.kind, step?.kind || "selector");
}

export function summarizeSavedWorkflow(workflow = {}) {
  return {
    id: workflow.id,
    title: workflow.title,
    goal: workflow.goal,
    steps: Array.isArray(workflow.steps)
      ? workflow.steps.slice(0, 3).map((step) => `${step.kind}:${step.label}`).join(" | ")
      : ""
  };
}

export function buildPlannerMemoryContext({
  goal,
  userMemory = DEFAULT_USER_MEMORY,
  domainMemory = {},
  savedWorkflows = []
}) {
  const domains = extractDomainsFromText(goal);
  const relevantDomains = domains
    .map((domain) => {
      const entry = domainMemory[domain];
      if (!entry) {
        return null;
      }
      return {
        hostname: domain,
        notes: entry.notes || [],
        selectors: Object.values(entry.selectors || {}).slice(0, 5)
      };
    })
    .filter(Boolean);

  return {
    userPreferences: (userMemory.preferences || []).slice(-6),
    userNotes: (userMemory.notes || []).slice(-6),
    relevantDomains,
    savedWorkflowExamples: savedWorkflows.slice(0, 4).map(summarizeSavedWorkflow)
  };
}

export function mergeUserMemory(current = DEFAULT_USER_MEMORY, patch = {}) {
  const preferences = [...new Set([...(current.preferences || []), ...(patch.preferences || [])])]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(-20);

  const notes = [...new Set([...(current.notes || []), ...(patch.notes || [])])]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(-20);

  return {
    ...DEFAULT_USER_MEMORY,
    ...current,
    ...patch,
    preferences,
    notes,
    defaults: {
      ...(current.defaults || {}),
      ...(patch.defaults || {})
    },
    updatedAt: Date.now()
  };
}

export function upsertDomainSelector(domainMemory = {}, { hostname, key, selector, label = "" }) {
  const safeHostname = String(hostname || "").replace(/^www\./i, "").trim().toLowerCase();
  const safeKey = normalizeKey(key, "selector");
  if (!safeHostname || !safeKey || !selector) {
    return domainMemory;
  }

  const currentEntry = domainMemory[safeHostname] || { hostname: safeHostname, notes: [], selectors: {} };
  const currentSelector = currentEntry.selectors[safeKey] || {
    key: safeKey,
    label,
    selector,
    successCount: 0,
    lastUsedAt: null
  };

  return {
    ...domainMemory,
    [safeHostname]: {
      ...currentEntry,
      hostname: safeHostname,
      selectors: {
        ...currentEntry.selectors,
        [safeKey]: {
          ...currentSelector,
          label: label || currentSelector.label,
          selector,
          successCount: Number(currentSelector.successCount || 0) + 1,
          lastUsedAt: Date.now()
        }
      }
    }
  };
}

export function normalizeWorkflowStep(step, index = 0) {
  if (!step || typeof step !== "object") {
    throw new Error(`Step ${index + 1} must be an object.`);
  }

  const kind = String(step.kind || "").trim();
  if (!WORKFLOW_STEP_KINDS.includes(kind)) {
    throw new Error(`Unsupported step kind "${kind || "unknown"}" at position ${index + 1}.`);
  }

  const normalized = {
    id: String(step.id || createId("step")),
    kind,
    label: String(step.label || `${kind.replaceAll("_", " ")} ${index + 1}`).trim(),
    args: step.args && typeof step.args === "object" ? step.args : {},
    outputKey: normalizeKey(step.outputKey || ""),
    approvalMode: [APPROVAL_MODES.AUTO, APPROVAL_MODES.ALWAYS].includes(step.approvalMode)
      ? step.approvalMode
      : (isRiskyStep(step) ? APPROVAL_MODES.ALWAYS : APPROVAL_MODES.AUTO),
    onFailure: [FAILURE_MODES.STOP, FAILURE_MODES.REPAIR].includes(step.onFailure)
      ? step.onFailure
      : (isDomStep(step) ? FAILURE_MODES.REPAIR : FAILURE_MODES.STOP),
    timeoutMs: Number.isFinite(Number(step.timeoutMs))
      ? Math.max(500, Math.min(120000, Number(step.timeoutMs)))
      : null
  };

  if (normalized.kind === "open_url" && !String(normalized.args.url || "").trim()) {
    throw new Error(`Step ${index + 1} is missing args.url.`);
  }

  return normalized;
}

export function normalizePlannerResponse(rawResponse, { goal, sourceMessageId }) {
  const mode = String(rawResponse?.mode || "plan").trim();
  if (mode === "question") {
    const question = String(rawResponse?.question || "").trim();
    if (!question) {
      throw new Error("Planner returned a question response without a question.");
    }
    return {
      mode,
      question,
      suggestions: Array.isArray(rawResponse?.suggestions)
        ? rawResponse.suggestions.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 3)
        : []
    };
  }

  const rawSteps = Array.isArray(rawResponse?.steps) ? rawResponse.steps : [];
  if (!rawSteps.length) {
    throw new Error("Planner returned no executable steps.");
  }

  const steps = rawSteps.map((step, index) => normalizeWorkflowStep(step, index));
  return {
    mode: "plan",
    plan: {
      id: String(rawResponse?.id || createId("plan")),
      goal: String(rawResponse?.goal || goal || "").trim(),
      title: String(rawResponse?.title || goal || "Untitled workflow").trim(),
      status: WORKFLOW_PLAN_STATUS.DRAFT,
      requiredOrigins: extractRequiredOrigins(steps),
      summary: String(rawResponse?.summary || "").trim(),
      steps,
      createdAt: Date.now(),
      sourceMessageId
    }
  };
}

export function validateWorkflowPlan(rawPlan) {
  const normalized = normalizePlannerResponse({ ...rawPlan, mode: "plan" }, {
    goal: rawPlan?.goal,
    sourceMessageId: rawPlan?.sourceMessageId || null
  });
  return normalized.plan;
}

export function buildFinalResultMessage(summary) {
  return createChatMessage(CHAT_MESSAGE_TYPES.FINAL_RESULT, summary);
}

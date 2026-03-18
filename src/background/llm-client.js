import { resolveProviderConfig } from "../shared/llm-providers.js";
import { normalizePlannerResponse, normalizeWorkflowStep } from "../shared/agent.js";

const PROVIDER_REQUEST_TIMEOUT_MS = 45000;

export function buildCommentPrompt({ task, settings }) {
  const systemPrompt = [
    "You write concise social media comments for real human engagement.",
    "Return strict JSON only.",
    'Format: {"comments":["..."]}',
    "Generate exactly one comment.",
    "The comment must be 1-3 sentences, add value, avoid spam, and feel specific to the post.",
    "It may include a question only if that feels natural.",
    "Do not use hashtags, emojis, or phrases like great post unless they are contextually necessary."
  ].join(" ");

  const userPrompt = [
    `Platform: ${task.platform}`,
    `Tone: ${settings.tone}`,
    `Author: ${task.content?.author || "Unknown"}`,
    "Post text:",
    task.content?.text || "",
    settings.customPromptSuffix ? `Extra guidance: ${settings.customPromptSuffix}` : "",
    "Generate 1 comment."
  ].filter(Boolean).join("\n");

  return { systemPrompt, userPrompt };
}

function extractOutputText(responseJson) {
  if (typeof responseJson.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  const outputs = Array.isArray(responseJson.output) ? responseJson.output : [];
  for (const output of outputs) {
    const contents = Array.isArray(output.content) ? output.content : [];
    for (const content of contents) {
      if (typeof content.text === "string" && content.text.trim()) {
        return content.text.trim();
      }
    }
  }

  return "";
}

function extractChoiceContent(responseJson) {
  return responseJson?.choices?.[0]?.message?.content?.trim?.() || "";
}

function extractGeminiContent(responseJson) {
  const parts = responseJson?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((part) => part?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractAnthropicContent(responseJson) {
  const parts = Array.isArray(responseJson?.content) ? responseJson.content : [];
  return parts
    .map((part) => part?.text || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseComments(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed?.comments)) {
      return parsed.comments.map((comment) => String(comment).trim()).filter(Boolean).slice(0, 1);
    }
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed?.comments)) {
          return parsed.comments.map((comment) => String(comment).trim()).filter(Boolean).slice(0, 1);
        }
      } catch {
        return [];
      }
    }
  }
  return [];
}

function parseJsonObject(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("Response did not contain a JSON object.");
    }
    return JSON.parse(match[0]);
  }
}

async function handleJsonResponse(response, providerLabel) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${providerLabel} request failed (${response.status}): ${text.slice(0, 240)}`);
  }
  return response.json();
}

async function fetchWithTimeout(url, options, timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort("provider_timeout");
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Provider request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callOpenAIResponses({ config, systemPrompt, userPrompt }) {
  const response = await fetchWithTimeout(`${config.baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: systemPrompt
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: userPrompt
            }
          ]
        }
      ]
    })
  });

  const json = await handleJsonResponse(response, config.label);
  return extractOutputText(json);
}

async function callOpenAICompatibleChat({ config, systemPrompt, userPrompt }) {
  const response = await fetchWithTimeout(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: config.maxOutputTokens
    })
  });

  const json = await handleJsonResponse(response, config.label);
  return extractChoiceContent(json);
}

async function callGeminiGenerateContent({ config, systemPrompt, userPrompt }) {
  const encodedModel = encodeURIComponent(config.model);
  const response = await fetchWithTimeout(`${config.baseUrl}/models/${encodedModel}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.apiKey
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: config.maxOutputTokens
      }
    })
  });

  const json = await handleJsonResponse(response, config.label);
  return extractGeminiContent(json);
}

async function callAnthropicMessages({ config, systemPrompt, userPrompt }) {
  const response = await fetchWithTimeout(`${config.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxOutputTokens,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: userPrompt
        }
      ]
    })
  });

  const json = await handleJsonResponse(response, config.label);
  return extractAnthropicContent(json);
}

async function callProvider({ config, systemPrompt, userPrompt }) {
  switch (config.kind) {
    case "openai-responses":
      return callOpenAIResponses({ config, systemPrompt, userPrompt });
    case "openai-chat":
      return callOpenAICompatibleChat({ config, systemPrompt, userPrompt });
    case "gemini-generate-content":
      return callGeminiGenerateContent({ config, systemPrompt, userPrompt });
    case "anthropic-messages":
      return callAnthropicMessages({ config, systemPrompt, userPrompt });
    default:
      throw new Error(`Unsupported LLM provider type: ${config.kind}`);
  }
}

async function callStructuredJson({ settings, systemPrompt, userPrompt, taskLabel }) {
  const config = resolveProviderConfig(settings);
  if (!config.apiKey) {
    throw new Error(`Add your ${config.label} API key in the extension options before generating ${taskLabel}.`);
  }

  const rawText = await callProvider({ config, systemPrompt, userPrompt });
  try {
    return parseJsonObject(rawText);
  } catch (error) {
    const repairPrompt = [
      "You repair malformed JSON outputs for a browser automation extension.",
      "Return strict JSON only.",
      "Do not add markdown fences or commentary.",
      `The JSON should satisfy this task: ${taskLabel}.`
    ].join(" ");
    const repairedText = await callProvider({
      config,
      systemPrompt: repairPrompt,
      userPrompt: [
        "Repair this model output into valid JSON without changing intent:",
        rawText
      ].join("\n\n")
    });

    try {
      return parseJsonObject(repairedText);
    } catch {
      throw new Error(`${config.label} returned invalid JSON for ${taskLabel}.`);
    }
  }
}

function buildPlanPrompt({ goal, memoryContext, starterPrompts }) {
  const systemPrompt = [
    "You are a browser workflow planner for a Chrome extension.",
    "Return strict JSON only.",
    "Use mode='plan' when you can build a plan or mode='question' when key information is missing.",
    "Available step kinds: open_url, click, type, select_option, wait_for, extract_text, extract_list, scroll, switch_tab, close_tab, summarize, ask_user.",
    "Each plan step must include kind, label, args, outputKey, approvalMode, onFailure, and optional timeoutMs.",
    "approvalMode must be auto or always.",
    "onFailure must be stop or repair.",
    "Use open_url args.url for any website navigation.",
    "For click/type/wait_for/extract_text, prefer selector when obvious. Otherwise use text, label, or placeholder.",
    "Use approvalMode='always' for risky or irreversible actions.",
    "Do not include steps that submit, purchase, publish, or confirm unless the goal clearly requires them.",
    "If the user intent is unclear, ask one concise question with mode='question'."
  ].join(" ");

  const userPrompt = [
    `Goal: ${goal}`,
    "Memory context:",
    JSON.stringify(memoryContext, null, 2),
    "Starter prompt examples:",
    JSON.stringify(starterPrompts, null, 2),
    "Return one JSON object matching either:",
    '{"mode":"question","question":"...","suggestions":["..."]}',
    "or",
    '{"mode":"plan","title":"...","summary":"...","steps":[{"kind":"open_url","label":"...","args":{"url":"https://example.com"},"outputKey":"","approvalMode":"auto","onFailure":"stop"}]}'
  ].join("\n");

  return { systemPrompt, userPrompt };
}

function buildRepairPrompt({ plan, step, errorMessage, pageSnapshot, outputs }) {
  const systemPrompt = [
    "You repair exactly one failed browser automation step.",
    "Return strict JSON only.",
    "You may only return a single workflow step object.",
    "Valid kinds: open_url, click, type, select_option, wait_for, extract_text, extract_list, scroll, switch_tab, close_tab, summarize, ask_user.",
    "Preserve the user's intent and keep the step as minimal as possible.",
    "Prefer selector repairs when the page snapshot exposes a better target."
  ].join(" ");

  const userPrompt = [
    "Plan context:",
    JSON.stringify({
      title: plan.title,
      goal: plan.goal,
      outputs
    }, null, 2),
    "Failed step:",
    JSON.stringify(step, null, 2),
    `Error: ${errorMessage}`,
    "Page snapshot:",
    JSON.stringify(pageSnapshot, null, 2),
    "Return one corrected step JSON object."
  ].join("\n");

  return { systemPrompt, userPrompt };
}

function buildSummaryPrompt({ plan, outputs, runState, step, runMemory }) {
  const systemPrompt = [
    "You summarize browser automation runs.",
    "Return strict JSON only.",
    'Format: {"summary":"..."}',
    "The summary should be concise, factual, and useful for a sidepanel UI."
  ].join(" ");

  const userPrompt = [
    "Plan:",
    JSON.stringify({
      title: plan.title,
      goal: plan.goal,
      currentStep: step?.label || null,
      status: runState?.status || null
    }, null, 2),
    "Outputs:",
    JSON.stringify(outputs || runMemory?.outputs || {}, null, 2),
    "Step results:",
    JSON.stringify(runMemory?.stepResults || [], null, 2),
    "Return strict JSON."
  ].join("\n");

  return { systemPrompt, userPrompt };
}

export async function planWorkflow({ goal, sourceMessageId, settings, memoryContext, starterPrompts = [] }) {
  const prompts = buildPlanPrompt({
    goal,
    memoryContext,
    starterPrompts
  });
  const parsed = await callStructuredJson({
    settings,
    systemPrompt: prompts.systemPrompt,
    userPrompt: prompts.userPrompt,
    taskLabel: "workflow planning"
  });
  return normalizePlannerResponse(parsed, { goal, sourceMessageId });
}

export async function repairStep({ settings, plan, step, errorMessage, pageSnapshot, outputs }) {
  const prompts = buildRepairPrompt({
    plan,
    step,
    errorMessage,
    pageSnapshot,
    outputs
  });
  const parsed = await callStructuredJson({
    settings,
    systemPrompt: prompts.systemPrompt,
    userPrompt: prompts.userPrompt,
    taskLabel: "browser step repair"
  });
  return normalizeWorkflowStep(parsed, 0);
}

export async function summarizeRun({ settings, plan, outputs, runState = null, step = null, runMemory = null }) {
  const prompts = buildSummaryPrompt({
    plan,
    outputs,
    runState,
    step,
    runMemory
  });
  const parsed = await callStructuredJson({
    settings,
    systemPrompt: prompts.systemPrompt,
    userPrompt: prompts.userPrompt,
    taskLabel: "run summarization"
  });
  return {
    summary: String(parsed?.summary || "").trim() || "Workflow completed."
  };
}

export async function generateCommentSuggestions({ settings, task }) {
  const config = resolveProviderConfig(settings);
  if (!config.apiKey) {
    throw new Error(`Add your ${config.label} API key in the extension options before generating comments.`);
  }

  const { systemPrompt, userPrompt } = buildCommentPrompt({ task, settings });
  const outputText = await callProvider({ config, systemPrompt, userPrompt });
  const comments = parseComments(outputText);
  if (!comments.length) {
    throw new Error(`The ${config.label} response did not contain parseable JSON comments.`);
  }
  return comments;
}

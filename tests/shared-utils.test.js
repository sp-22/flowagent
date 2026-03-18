import test from "node:test";
import assert from "node:assert/strict";

import { buildXSearchUrl, canonicalizeXUrl } from "../src/platforms/x.js";
import {
  buildLinkedInSearchUrl,
  canonicalizeLinkedInUrl
} from "../src/platforms/linkedin.js";
import { getGoogleSearchText } from "../src/shared/google-search.js";
import { filterProviderModels, resolveProviderConfig } from "../src/shared/llm-providers.js";
import { normalizeSettings, pickDailyTarget } from "../src/shared/utils.js";
import { TIME_FILTERS } from "../src/shared/constants.js";

test("normalizeSettings trims queries and keeps platform defaults", () => {
  const settings = normalizeSettings({
    queries: " ai agents \n\n growth loops ",
    platforms: [],
    llmProvider: "openai",
    apiKey: "demo-key"
  });

  assert.deepEqual(settings.queries, ["ai agents", "growth loops"]);
  assert.equal(settings.platforms.length, 2);
  assert.equal(settings.llmAccounts.length, 1);
  assert.equal(settings.activeLlmAccountId, "legacy-account");
  assert.equal(settings.llmAccounts[0].apiKey, "demo-key");
});

test("pickDailyTarget stays inside the configured range", () => {
  for (let index = 0; index < 100; index += 1) {
    const value = pickDailyTarget({ min: 20, max: 30 });
    assert.ok(value >= 20 && value <= 30);
  }
});

test("buildXSearchUrl uses Google search with the raw query", () => {
  const url = buildXSearchUrl("openai", TIME_FILTERS.LAST_24_HOURS);
  assert.ok(url.startsWith("https://www.google.com/search?"));
  assert.equal(getGoogleSearchText(url), "openai");
});

test("canonicalizeXUrl normalizes hostname and removes query params", () => {
  const url = canonicalizeXUrl("https://twitter.com/test/status/12345?s=20");
  assert.equal(url, "https://x.com/test/status/12345");
});

test("buildLinkedInSearchUrl uses Google search with the raw query", () => {
  const url = buildLinkedInSearchUrl("demand gen", TIME_FILTERS.LAST_WEEK);
  assert.ok(url.startsWith("https://www.google.com/search?"));
  assert.equal(getGoogleSearchText(url), "demand gen");
});

test("canonicalizeLinkedInUrl strips search params", () => {
  const url = canonicalizeLinkedInUrl("https://www.linkedin.com/feed/update/urn:li:activity:1/?trk=feed");
  assert.equal(url, "https://www.linkedin.com/feed/update/urn:li:activity:1");
});

test("resolveProviderConfig prefers the active LLM account", () => {
  const settings = normalizeSettings({
    llmAccounts: [
      {
        id: "account-openai",
        providerId: "openai",
        apiKey: "openai-key",
        selectedModel: "gpt-5-mini"
      },
      {
        id: "account-nvidia",
        providerId: "nvidia",
        apiKey: "nvidia-key",
        selectedModel: "meta/llama-3.1-70b-instruct"
      }
    ],
    activeLlmAccountId: "account-nvidia"
  });
  const config = resolveProviderConfig(settings);

  assert.equal(config.kind, "openai-chat");
  assert.equal(config.baseUrl, "https://integrate.api.nvidia.com/v1");
  assert.equal(config.accountId, "account-nvidia");
  assert.equal(config.apiKey, "nvidia-key");
  assert.equal(config.model, "meta/llama-3.1-70b-instruct");
});

test("filterProviderModels keeps only text LLMs", () => {
  assert.deepEqual(filterProviderModels("openai", [
    "gpt-5-mini",
    "text-embedding-3-large",
    "gpt-image-1",
    "whisper-1"
  ]), ["gpt-5-mini"]);

  assert.deepEqual(filterProviderModels("gemini", [
    "gemini-2.5-flash",
    "gemini-embedding-001",
    "imagen-3.0-generate-002"
  ]), ["gemini-2.5-flash"]);

  assert.deepEqual(filterProviderModels("nvidia", [
    "meta/llama-3.1-70b-instruct",
    "snowflake/arctic-embed-l",
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "nvidia/neva-22b"
  ]), [
    "meta/llama-3.1-70b-instruct",
    "nvidia/llama-3.1-nemotron-70b-instruct"
  ]);
});

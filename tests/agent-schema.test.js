import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPlannerMemoryContext,
  extractRequiredOrigins,
  isRiskyStep,
  resolveTemplateVariables,
  validateWorkflowPlan
} from "../src/shared/agent.js";

test("validateWorkflowPlan normalizes steps and required origins", () => {
  const plan = validateWorkflowPlan({
    goal: "Research competitors",
    title: "Competitor research",
    steps: [
      {
        kind: "open_url",
        label: "Open Product Hunt",
        args: {
          url: "https://www.producthunt.com/posts/example"
        }
      },
      {
        kind: "click",
        label: "Submit the form",
        args: {
          selector: "button[type='submit']"
        }
      }
    ]
  });

  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.requiredOrigins, ["https://www.producthunt.com/*"]);
  assert.equal(plan.steps[1].approvalMode, "always");
});

test("resolveTemplateVariables substitutes nested values", () => {
  const resolved = resolveTemplateVariables({
    query: "{{search_query}}",
    meta: {
      title: "Result for {{search_query}}"
    }
  }, {
    search_query: "AI agents"
  });

  assert.deepEqual(resolved, {
    query: "AI agents",
    meta: {
      title: "Result for AI agents"
    }
  });
});

test("buildPlannerMemoryContext keeps memory deterministic", () => {
  const context = buildPlannerMemoryContext({
    goal: "Open example.com and summarize the pricing page",
    userMemory: {
      preferences: ["Prefer compact summaries"],
      notes: ["Pause before any checkout step"]
    },
    domainMemory: {
      "example.com": {
        hostname: "example.com",
        selectors: {
          pricing_button: {
            selector: "a[href='/pricing']",
            label: "Pricing button"
          }
        },
        notes: ["Pricing lives in the nav"]
      }
    },
    savedWorkflows: [
      {
        id: "wf-1",
        title: "Pricing recon",
        goal: "Research pricing",
        steps: [{ kind: "open_url", label: "Open home" }]
      }
    ]
  });

  assert.equal(context.userPreferences[0], "Prefer compact summaries");
  assert.equal(context.relevantDomains[0].hostname, "example.com");
  assert.equal(context.savedWorkflowExamples[0].title, "Pricing recon");
});

test("extractRequiredOrigins and isRiskyStep stay bounded", () => {
  const steps = [
    {
      kind: "open_url",
      args: {
        url: "https://news.ycombinator.com/item?id=1"
      }
    },
    {
      kind: "type",
      label: "Confirm delete",
      args: {
        selector: "#confirm"
      }
    }
  ];

  assert.deepEqual(extractRequiredOrigins(steps), ["https://news.ycombinator.com/*"]);
  assert.equal(isRiskyStep(steps[1]), true);
});

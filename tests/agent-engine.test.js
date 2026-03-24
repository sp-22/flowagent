import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_RUN_STATUS } from "../src/shared/constants.js";
import { AgentEngine } from "../src/background/agent-engine.js";
import {
  getCurrentRun,
  getDraftPlan,
  getSavedWorkflows,
  initializeAgentStorage,
  replaceCurrentRun,
  saveDraftPlan,
  upsertSavedWorkflow
} from "../src/background/agent-storage.js";
import { initializeStorage } from "../src/background/storage.js";
import { createChromeStub } from "../test-support/chrome-stub.js";

function installChromeStub(initialStorage = {}) {
  global.chrome = createChromeStub(initialStorage).chrome;
}

async function seedStorage() {
  await initializeStorage();
  await initializeAgentStorage();
}

test.beforeEach(async () => {
  installChromeStub();
  await seedStorage();
});

test("executePlan starts a run and approveStep resumes a pending approval", async () => {
  const engine = new AgentEngine();
  engine.scheduleProcess = () => {};

  await saveDraftPlan({
    id: "plan-1",
    title: "Approval test",
    goal: "Confirm a step",
    status: "approved",
    requiredOrigins: [],
    steps: [
      {
        id: "step-1",
        kind: "ask_user",
        label: "Confirm the next move",
        args: {
          question: "Continue?"
        },
        outputKey: "",
        approvalMode: "always",
        onFailure: "stop",
        timeoutMs: null
      }
    ]
  });

  await engine.executePlan();
  let run = await getCurrentRun();
  assert.equal(run.status, AGENT_RUN_STATUS.RUNNING);

  await replaceCurrentRun({
    ...run,
    status: AGENT_RUN_STATUS.PAUSED_FOR_STEP_APPROVAL,
    awaitingApprovalStepId: "step-1",
    approvedStepIds: []
  });

  await engine.approveStep({
    stepId: "step-1",
    decision: "approve"
  });

  run = await getCurrentRun();
  assert.equal(run.status, AGENT_RUN_STATUS.RUNNING);
  assert.ok(run.approvedStepIds.includes("step-1"));
});

test("executeWithRecovery retries twice and succeeds with a repaired step", async () => {
  const originalStep = {
    id: "step-repair",
    kind: "click",
    label: "Click broken selector",
    args: {
      selector: ".broken"
    },
    outputKey: "",
    approvalMode: "auto",
    onFailure: "repair",
    timeoutMs: null
  };

  const engine = new AgentEngine({
    repairStepImpl: async () => ({
      ...originalStep,
      args: {
        selector: "#fixed"
      }
    })
  });

  let attempts = 0;
  engine.executeStep = async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error("selector failed");
    }
    return {
      status: "success",
      output: "clicked"
    };
  };
  engine.executePageStep = async () => ({
    ok: true,
    output: {
      buttons: [{ text: "Continue", selector: "#fixed" }]
    }
  });

  const result = await engine.executeWithRecovery(originalStep, {
    activeTabId: 1,
    outputs: {}
  }, {
    id: "plan-2",
    title: "Repair flow",
    goal: "Fix selector",
    steps: [originalStep]
  });

  assert.equal(attempts, 3);
  assert.equal(result.status, "success");
  assert.equal(result.executedStep.args.selector, "#fixed");
});

test("executeWithRecovery pauses the run after retry and repair failure", async () => {
  const step = {
    id: "step-fail",
    kind: "type",
    label: "Type into the missing field",
    args: {
      selector: "#missing",
      text: "Hello"
    },
    outputKey: "",
    approvalMode: "auto",
    onFailure: "repair",
    timeoutMs: null
  };

  const engine = new AgentEngine({
    repairStepImpl: async () => ({
      ...step,
      args: {
        selector: "#still-missing",
        text: "Hello"
      }
    })
  });

  engine.executeStep = async () => {
    throw new Error("still broken");
  };
  engine.executePageStep = async () => ({
    ok: true,
    output: {
      inputs: [{ text: "Message", selector: "#still-missing" }]
    }
  });

  await saveDraftPlan({
    id: "plan-3",
    title: "Failure flow",
    goal: "Pause after repair failure",
    status: "approved",
    requiredOrigins: [],
    steps: [step]
  });
  await replaceCurrentRun({
    planId: "plan-3",
    status: AGENT_RUN_STATUS.RUNNING,
    currentStepIndex: 0,
    activeTabId: 1,
    outputs: {}
  });

  const result = await engine.executeWithRecovery(step, {
    activeTabId: 1,
    outputs: {}
  }, {
    id: "plan-3",
    title: "Failure flow",
    goal: "Pause after repair failure",
    steps: [step]
  });

  assert.equal(result.status, "paused");
  const run = await getCurrentRun();
  assert.equal(run.status, AGENT_RUN_STATUS.PAUSED_FOR_ERROR);
  assert.equal(run.awaitingApprovalStepId, "step-fail");
});

test("runSavedWorkflow injects template inputs and updates saved workflow metadata", async () => {
  const engine = new AgentEngine();
  engine.scheduleProcess = () => {};

  await upsertSavedWorkflow({
    id: "workflow-1",
    title: "Template flow",
    goal: "Open a start page",
    summary: "Reusable template",
    steps: [
      {
        id: "step-1",
        kind: "open_url",
        label: "Open start URL",
        args: {
          url: "https://example.com"
        }
      }
    ],
    templateInputs: [
      {
        id: "step-1:url",
        key: "start_url",
        label: "Start URL",
        defaultValue: "https://example.com",
        stepId: "step-1",
        argKey: "url"
      }
    ]
  });

  await engine.runSavedWorkflow({
    workflowId: "workflow-1",
    inputs: {
      start_url: "https://openai.com"
    }
  });

  const run = await getCurrentRun();
  const draftPlan = await getDraftPlan();
  const savedWorkflows = await getSavedWorkflows();

  assert.equal(run.status, AGENT_RUN_STATUS.RUNNING);
  assert.equal(run.sourceWorkflowId, "workflow-1");
  assert.equal(draftPlan.steps[0].args.url, "https://openai.com");
  assert.equal(savedWorkflows[0].runCount, 1);
  assert.equal(savedWorkflows[0].lastRunStatus, AGENT_RUN_STATUS.RUNNING);
});

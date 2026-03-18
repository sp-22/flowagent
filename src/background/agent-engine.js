import {
  AGENT_RUN_STATUS,
  APPROVAL_MODES,
  CHAT_MESSAGE_TYPES,
  DEFAULT_AGENT_RUN_STATE,
  FAILURE_MODES,
  STARTER_PROMPTS,
  WORKFLOW_PLAN_STATUS
} from "../shared/constants.js";
import { MESSAGE_TYPES } from "../shared/messages.js";
import {
  buildFinalResultMessage,
  buildPlannerMemoryContext,
  buildSelectorMemoryKey,
  createChatMessage,
  isDomStep,
  mergeUserMemory,
  resolveTemplateVariables,
  upsertDomainSelector,
  validateWorkflowPlan
} from "../shared/agent.js";
import { createId, sleep } from "../shared/utils.js";
import { pageToolExecutor } from "../content/page-tools.js";
import { getSettings, initializeStorage } from "./storage.js";
import {
  appendChatMessages,
  clearChatThread,
  getAgentSnapshot,
  getCurrentRun,
  getDomainMemory,
  getDraftPlan,
  getSavedWorkflows,
  getSessionMemory,
  getUserMemory,
  initializeAgentStorage,
  replaceCurrentRun,
  saveDomainMemory,
  saveDraftPlan,
  saveSessionMemory,
  saveUserMemory,
  setCurrentRun,
  updateSessionMemoryForRun,
  upsertSavedWorkflow
} from "./agent-storage.js";
import { planWorkflow, repairStep, summarizeRun } from "./llm-client.js";

async function broadcastAgentSnapshot() {
  const snapshot = await getAgentSnapshot();
  try {
    await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.AGENT_STATUS_UPDATE,
      payload: snapshot
    });
  } catch {
    // Sidepanel or popup may not be open.
  }
  return snapshot;
}

async function waitForTabComplete(tabId, timeoutMs = 25000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return tab;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for tab ${tabId} to load.`);
}

function truncateText(text, limit = 900) {
  const safe = String(text || "").trim();
  if (safe.length <= limit) {
    return safe;
  }
  return `${safe.slice(0, limit - 1)}…`;
}

async function getTab(tabId) {
  if (!tabId) {
    return null;
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

export class AgentEngine {
  constructor(options = {}) {
    this.processing = false;
    this.hooks = {
      planWorkflowImpl: options.planWorkflowImpl || planWorkflow,
      repairStepImpl: options.repairStepImpl || repairStep,
      summarizeRunImpl: options.summarizeRunImpl || summarizeRun
    };
  }

  scheduleProcess() {
    queueMicrotask(() => {
      void this.process();
    });
  }

  async init() {
    await initializeStorage();
    await initializeAgentStorage();
  }

  async getCurrentPlan() {
    return getDraftPlan();
  }

  async appendChat(type, content, data = {}) {
    await appendChatMessages([createChatMessage(type, content, data)]);
  }

  async planFromChat({ goal }) {
    await this.init();
    const trimmedGoal = String(goal || "").trim();
    if (!trimmedGoal) {
      throw new Error("Describe the browser task you want automated.");
    }

    const userMessage = createChatMessage(CHAT_MESSAGE_TYPES.USER_MESSAGE, trimmedGoal);
    await appendChatMessages([userMessage]);

    const [userMemory, domainMemory, savedWorkflows, settings] = await Promise.all([
      getUserMemory(),
      getDomainMemory(),
      getSavedWorkflows(),
      getSettings()
    ]);

    try {
      const plannerResponse = await this.hooks.planWorkflowImpl({
        goal: trimmedGoal,
        sourceMessageId: userMessage.id,
        settings,
        memoryContext: buildPlannerMemoryContext({
          goal: trimmedGoal,
          userMemory,
          domainMemory,
          savedWorkflows
        }),
        starterPrompts: STARTER_PROMPTS
      });

      if (plannerResponse.mode === "question") {
        await saveDraftPlan(null);
        await replaceCurrentRun({
          status: AGENT_RUN_STATUS.IDLE,
          planId: null,
          error: ""
        });
        await this.appendChat(CHAT_MESSAGE_TYPES.ASSISTANT_QUESTION, plannerResponse.question, {
          suggestions: plannerResponse.suggestions || []
        });
        return broadcastAgentSnapshot();
      }

      await saveDraftPlan(plannerResponse.plan);
      await replaceCurrentRun({
        status: AGENT_RUN_STATUS.NEEDS_PLAN_APPROVAL,
        planId: plannerResponse.plan.id,
        currentStepIndex: 0,
        awaitingApprovalStepId: null,
        error: "",
        summary: ""
      });
      await this.appendChat(
        CHAT_MESSAGE_TYPES.ASSISTANT_PLAN,
        plannerResponse.plan.summary || `Drafted a ${plannerResponse.plan.steps.length}-step workflow.`,
        {
          planId: plannerResponse.plan.id,
          title: plannerResponse.plan.title
        }
      );
      await this.appendChat(
        CHAT_MESSAGE_TYPES.APPROVAL_REQUEST,
        "Review the generated steps, adjust anything you want, then approve the plan before execution.",
        {
          planId: plannerResponse.plan.id,
          mode: "plan"
        }
      );
      return broadcastAgentSnapshot();
    } catch (error) {
      await replaceCurrentRun({
        status: AGENT_RUN_STATUS.ERROR,
        planId: null,
        error: error.message
      });
      await this.appendChat(CHAT_MESSAGE_TYPES.ERROR_EVENT, error.message);
      return broadcastAgentSnapshot();
    }
  }

  async updateDraftPlan({ plan }) {
    await this.init();
    const validated = validateWorkflowPlan(plan);
    const currentPlan = await getDraftPlan();
    const nextPlan = {
      ...validated,
      id: validated.id || currentPlan?.id || createId("plan"),
      sourceMessageId: validated.sourceMessageId || currentPlan?.sourceMessageId || null,
      status: currentPlan?.status === WORKFLOW_PLAN_STATUS.APPROVED
        ? WORKFLOW_PLAN_STATUS.APPROVED
        : WORKFLOW_PLAN_STATUS.DRAFT
    };
    await saveDraftPlan(nextPlan);
    await setCurrentRun({
      planId: nextPlan.id,
      status: nextPlan.status === WORKFLOW_PLAN_STATUS.APPROVED
        ? AGENT_RUN_STATUS.IDLE
        : AGENT_RUN_STATUS.NEEDS_PLAN_APPROVAL,
      error: ""
    });
    await this.appendChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      "Updated the draft workflow steps."
    );
    return broadcastAgentSnapshot();
  }

  async discardDraftPlan() {
    await this.init();
    await saveDraftPlan(null);
    await replaceCurrentRun({
      ...DEFAULT_AGENT_RUN_STATE,
      status: AGENT_RUN_STATUS.IDLE,
      error: "",
      summary: ""
    });
    await this.appendChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      "Dismissed the draft workflow."
    );
    return broadcastAgentSnapshot();
  }

  async approvePlan() {
    await this.init();
    const plan = await getDraftPlan();
    if (!plan) {
      throw new Error("There is no draft plan to approve.");
    }
    const approvedPlan = {
      ...plan,
      status: WORKFLOW_PLAN_STATUS.APPROVED,
      approvedAt: Date.now()
    };
    await saveDraftPlan(approvedPlan);
    await setCurrentRun({
      planId: approvedPlan.id,
      status: AGENT_RUN_STATUS.IDLE,
      error: ""
    });
    await this.appendChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      "Plan approved. Execution is still manual until you click Run."
    );
    return broadcastAgentSnapshot();
  }

  async executePlan() {
    await this.init();
    const plan = await getDraftPlan();
    const currentRun = await getCurrentRun();
    if (!plan) {
      throw new Error("Create a plan before running anything.");
    }
    if (plan.status !== WORKFLOW_PLAN_STATUS.APPROVED) {
      throw new Error("Approve the plan before execution.");
    }

    if (currentRun.planId === plan.id && currentRun.status === AGENT_RUN_STATUS.PAUSED) {
      await setCurrentRun({
        status: AGENT_RUN_STATUS.RUNNING,
        error: ""
      });
      await this.appendChat(
        CHAT_MESSAGE_TYPES.TOOL_EVENT,
        `Resumed workflow: ${plan.title}`
      );
      await broadcastAgentSnapshot();
      this.scheduleProcess();
      return getAgentSnapshot();
    }

    await replaceCurrentRun({
      planId: plan.id,
      status: AGENT_RUN_STATUS.RUNNING,
      currentStepIndex: 0,
      awaitingApprovalStepId: null,
      activeTabId: null,
      activeUrl: "",
      outputs: {},
      error: "",
      approvedStepIds: [],
      openTabIds: [],
      lastStepResult: null,
      pendingResolution: null,
      startedAt: Date.now(),
      completedAt: null,
      summary: "",
      needsPermissionOrigins: []
    });
    const existingSessionMemory = await getSessionMemory();
    await saveSessionMemory({
      currentPlanId: plan.id,
      runs: {
        ...(existingSessionMemory.runs || {}),
        [plan.id]: {
          goal: plan.goal,
          outputs: {},
          startedAt: Date.now(),
          stepResults: []
        }
      },
      recentFacts: existingSessionMemory.recentFacts || []
    });
    await this.appendChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      `Started workflow: ${plan.title}`
    );
    await broadcastAgentSnapshot();
    this.scheduleProcess();
    return getAgentSnapshot();
  }

  async pauseExecution() {
    const run = await getCurrentRun();
    if (run.status !== AGENT_RUN_STATUS.RUNNING) {
      return broadcastAgentSnapshot();
    }
    await setCurrentRun({
      status: AGENT_RUN_STATUS.PAUSED
    });
    await this.appendChat(CHAT_MESSAGE_TYPES.TOOL_EVENT, "Paused execution.");
    return broadcastAgentSnapshot();
  }

  async stopExecution() {
    const run = await getCurrentRun();
    await setCurrentRun({
      status: AGENT_RUN_STATUS.STOPPED,
      error: "",
      awaitingApprovalStepId: null,
      pendingResolution: null,
      completedAt: Date.now()
    });
    await this.appendChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      run.status === AGENT_RUN_STATUS.COMPLETED
        ? "Workflow is already complete."
        : "Stopped execution."
    );
    return broadcastAgentSnapshot();
  }

  async resetSession() {
    await this.init();
    await clearChatThread();
    await saveDraftPlan(null);
    await replaceCurrentRun({
      ...DEFAULT_AGENT_RUN_STATE,
      status: AGENT_RUN_STATUS.IDLE,
      error: "",
      summary: ""
    });
    return broadcastAgentSnapshot();
  }

  async approveStep({ stepId, decision = "approve" }) {
    await this.init();
    const run = await getCurrentRun();
    const plan = await getDraftPlan();
    if (!plan || !run.awaitingApprovalStepId || run.awaitingApprovalStepId !== stepId) {
      throw new Error("No matching step is waiting for approval.");
    }

    if (decision === "stop") {
      return this.stopExecution();
    }

    if (decision === "skip") {
      const step = plan.steps.find((item) => item.id === stepId);
      await this.recordStepResult(step, {
        status: "skipped",
        output: null,
        note: "User skipped this step."
      });
      await setCurrentRun({
        status: AGENT_RUN_STATUS.RUNNING,
        currentStepIndex: run.currentStepIndex + 1,
        awaitingApprovalStepId: null,
        pendingResolution: null,
        error: ""
      });
      await this.appendChat(
        CHAT_MESSAGE_TYPES.TOOL_EVENT,
        `Skipped step: ${step?.label || stepId}`
      );
      await broadcastAgentSnapshot();
      this.scheduleProcess();
      return getAgentSnapshot();
    }

    await setCurrentRun({
      status: AGENT_RUN_STATUS.RUNNING,
      awaitingApprovalStepId: null,
      pendingResolution: null,
      approvedStepIds: [...new Set([...(run.approvedStepIds || []), stepId])],
      error: ""
    });
    await this.appendChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      "Approved the pending step. Execution resumed."
    );
    await broadcastAgentSnapshot();
    this.scheduleProcess();
    return getAgentSnapshot();
  }

  async saveWorkflow({ workflowId = null }) {
    await this.init();
    const plan = await getDraftPlan();
    if (!plan) {
      throw new Error("There is no plan to save.");
    }
    const workflow = {
      ...plan,
      id: workflowId || plan.id,
      savedAt: Date.now()
    };
    await upsertSavedWorkflow(workflow);
    await this.appendChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      `Saved workflow template: ${workflow.title}`
    );
    return broadcastAgentSnapshot();
  }

  async loadWorkflow({ workflowId }) {
    await this.init();
    const workflows = await getSavedWorkflows();
    const workflow = workflows.find((item) => item.id === workflowId);
    if (!workflow) {
      throw new Error("Saved workflow not found.");
    }
    const loadedPlan = {
      ...workflow,
      status: WORKFLOW_PLAN_STATUS.DRAFT,
      loadedAt: Date.now()
    };
    await saveDraftPlan(loadedPlan);
    await replaceCurrentRun({
      planId: loadedPlan.id,
      status: AGENT_RUN_STATUS.NEEDS_PLAN_APPROVAL,
      error: ""
    });
    await this.appendChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      `Loaded workflow template: ${loadedPlan.title}`
    );
    return broadcastAgentSnapshot();
  }

  async upsertMemory({ preferences = [], notes = [], defaults = {} }) {
    await this.init();
    const nextMemory = mergeUserMemory(await getUserMemory(), {
      preferences,
      notes,
      defaults
    });
    await saveUserMemory(nextMemory);
    await this.appendChat(
      CHAT_MESSAGE_TYPES.TOOL_EVENT,
      "Saved the memory note for future plans."
    );
    return broadcastAgentSnapshot();
  }

  async recordStepResult(step, result) {
    const run = await getCurrentRun();
    await updateSessionMemoryForRun(run.planId, {
      outputs: {
        ...(run.outputs || {}),
        ...(step?.outputKey && result.output !== undefined ? { [step.outputKey]: result.output } : {})
      },
      stepResults: [
        ...((((await getSessionMemory()).runs?.[run.planId]?.stepResults) || [])),
        {
          stepId: step?.id || null,
          label: step?.label || "",
          status: result.status,
          output: result.output ?? null,
          note: result.note || "",
          timestamp: Date.now()
        }
      ]
    });
  }

  async resolveStep(step, outputs) {
    return {
      ...step,
      args: resolveTemplateVariables(step.args, outputs)
    };
  }

  async executePageStep(tabId, action, payload, timeoutMs) {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageToolExecutor,
      args: [{
        action,
        payload,
        timeoutMs
      }]
    });
    return result?.result || { ok: false, error: "Unknown page execution failure." };
  }

  async summarizeStep({ step, runState, plan }) {
    const settings = await getSettings();
    const summary = await this.hooks.summarizeRunImpl({
      settings,
      plan,
      step,
      outputs: runState.outputs
    });
    return {
      status: "success",
      output: summary.summary
    };
  }

  async executeStep(step, runState, plan) {
    const resolvedStep = await this.resolveStep(step, runState.outputs);
    switch (resolvedStep.kind) {
      case "open_url": {
        const targetUrl = String(resolvedStep.args.url || "").trim();
        const shouldReuse = resolvedStep.args.reuseActiveTab === true && runState.activeTabId;
        const tab = shouldReuse
          ? await chrome.tabs.update(runState.activeTabId, { url: targetUrl, active: true })
          : await chrome.tabs.create({ url: targetUrl, active: true });
        await waitForTabComplete(tab.id, resolvedStep.timeoutMs || 25000);
        await setCurrentRun({
          activeTabId: tab.id,
          activeUrl: targetUrl,
          openTabIds: [...new Set([...(runState.openTabIds || []), tab.id])]
        });
        return {
          status: "success",
          output: targetUrl
        };
      }

      case "switch_tab": {
        const tabs = await Promise.all((runState.openTabIds || []).map((tabId) => getTab(tabId)));
        const candidates = tabs.filter(Boolean);
        let target = null;
        if (Number.isInteger(resolvedStep.args.tabIndex)) {
          target = candidates[resolvedStep.args.tabIndex] || null;
        }
        if (!target && resolvedStep.args.urlContains) {
          target = candidates.find((tab) => (tab.url || "").includes(resolvedStep.args.urlContains)) || null;
        }
        if (!target && resolvedStep.args.titleContains) {
          target = candidates.find((tab) => (tab.title || "").includes(resolvedStep.args.titleContains)) || null;
        }
        if (!target && candidates.length) {
          target = candidates.at(-1);
        }
        if (!target) {
          throw new Error("No matching tab was available to switch to.");
        }
        await chrome.tabs.update(target.id, { active: true });
        await setCurrentRun({
          activeTabId: target.id,
          activeUrl: target.url || runState.activeUrl
        });
        return {
          status: "success",
          output: target.url || ""
        };
      }

      case "close_tab": {
        const targetTabId = resolvedStep.args.tabId || runState.activeTabId;
        if (!targetTabId) {
          throw new Error("There is no active tab to close.");
        }
        await chrome.tabs.remove(targetTabId);
        const nextOpenTabs = (runState.openTabIds || []).filter((tabId) => tabId !== targetTabId);
        const nextActiveTab = nextOpenTabs.at(-1) || null;
        const nextTab = await getTab(nextActiveTab);
        await setCurrentRun({
          activeTabId: nextActiveTab,
          activeUrl: nextTab?.url || "",
          openTabIds: nextOpenTabs
        });
        return {
          status: "success",
          output: targetTabId
        };
      }

      case "summarize":
        return this.summarizeStep({
          step: resolvedStep,
          runState,
          plan
        });

      case "ask_user":
        await setCurrentRun({
          status: AGENT_RUN_STATUS.PAUSED_FOR_STEP_APPROVAL,
          awaitingApprovalStepId: resolvedStep.id,
          pendingResolution: {
            type: "ask_user",
            message: resolvedStep.args.question || resolvedStep.label
          }
        });
        await this.appendChat(
          CHAT_MESSAGE_TYPES.APPROVAL_REQUEST,
          resolvedStep.args.question || resolvedStep.label,
          {
            stepId: resolvedStep.id,
            mode: "ask_user"
          }
        );
        return { status: "paused" };

      default: {
        if (!runState.activeTabId) {
          throw new Error(`Step "${resolvedStep.label}" requires an active browser tab.`);
        }
        const result = await this.executePageStep(
          runState.activeTabId,
          resolvedStep.kind,
          resolvedStep.args,
          resolvedStep.timeoutMs || 15000
        );
        if (!result?.ok) {
          throw new Error(result?.error || `Step "${resolvedStep.label}" failed.`);
        }
        const tab = await getTab(runState.activeTabId);
        await setCurrentRun({
          activeUrl: tab?.url || runState.activeUrl
        });
        return {
          status: "success",
          output: result.output
        };
      }
    }
  }

  async executeWithRecovery(step, runState, plan) {
    let repairedStep = null;
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.executeStep(repairedStep || step, runState, plan);
        return {
          ...result,
          executedStep: repairedStep || step
        };
      } catch (error) {
        lastError = error;
      }
    }

    if (step.onFailure !== FAILURE_MODES.REPAIR || !isDomStep(step) || !runState.activeTabId) {
      throw lastError;
    }

    const inspectResult = await this.executePageStep(runState.activeTabId, "inspect_page", {}, 4000);
    if (!inspectResult?.ok) {
      throw lastError;
    }

    const settings = await getSettings();
    repairedStep = await this.hooks.repairStepImpl({
      settings,
      plan,
      step,
      errorMessage: lastError.message,
      pageSnapshot: inspectResult.output,
      outputs: runState.outputs
    });

    try {
      const repairedResult = await this.executeStep(repairedStep, runState, plan);
      await saveDraftPlan({
        ...plan,
        steps: plan.steps.map((item) => item.id === step.id ? repairedStep : item)
      });
      return {
        ...repairedResult,
        executedStep: repairedStep
      };
    } catch (repairError) {
      const nextError = repairError.message || lastError.message;
      await setCurrentRun({
        status: AGENT_RUN_STATUS.PAUSED_FOR_ERROR,
        awaitingApprovalStepId: step.id,
        error: nextError,
        pendingResolution: {
          type: "step_failure",
          stepId: step.id,
          message: nextError
        }
      });
      await this.appendChat(
        CHAT_MESSAGE_TYPES.ERROR_EVENT,
        `Step failed after retry and repair: ${step.label}. Edit the step, skip it, or stop the run.`,
        {
          stepId: step.id,
          error: nextError
        }
      );
      return { status: "paused" };
    }
  }

  async maybePersistDomainMemory(step, runState) {
    const selector = String(step?.args?.selector || "").trim();
    if (!selector || !runState.activeUrl) {
      return;
    }
    try {
      const hostname = new URL(runState.activeUrl).hostname.replace(/^www\./i, "");
      const nextMemory = upsertDomainSelector(await getDomainMemory(), {
        hostname,
        key: buildSelectorMemoryKey(step),
        selector,
        label: step.label
      });
      await saveDomainMemory(nextMemory);
    } catch {
      // Ignore domain memory failures for non-URL tabs.
    }
  }

  async completeRun(plan, runState) {
    const settings = await getSettings();
    const sessionMemory = await getSessionMemory();
    const runMemory = sessionMemory.runs?.[plan.id] || {};
    const summaryResponse = await this.hooks.summarizeRunImpl({
      settings,
      plan,
      outputs: runState.outputs,
      runState,
      runMemory
    });
    await setCurrentRun({
      status: AGENT_RUN_STATUS.COMPLETED,
      completedAt: Date.now(),
      summary: summaryResponse.summary || "",
      error: "",
      awaitingApprovalStepId: null,
      pendingResolution: null
    });
    await appendChatMessages([
      buildFinalResultMessage(summaryResponse.summary || "Workflow completed.")
    ]);
    return broadcastAgentSnapshot();
  }

  async process() {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      await this.init();
      const [plan, runState] = await Promise.all([
        getDraftPlan(),
        getCurrentRun()
      ]);

      if (!plan || runState.status !== AGENT_RUN_STATUS.RUNNING) {
        return;
      }

      const step = plan.steps[runState.currentStepIndex];
      if (!step) {
        await this.completeRun(plan, runState);
        return;
      }

      if (
        step.approvalMode === APPROVAL_MODES.ALWAYS
        && !(runState.approvedStepIds || []).includes(step.id)
      ) {
        await setCurrentRun({
          status: AGENT_RUN_STATUS.PAUSED_FOR_STEP_APPROVAL,
          awaitingApprovalStepId: step.id,
          pendingResolution: {
            type: "approval",
            stepId: step.id
          }
        });
        await this.appendChat(
          CHAT_MESSAGE_TYPES.APPROVAL_REQUEST,
          `Approval required before "${step.label}".`,
          {
            stepId: step.id,
            mode: "risky_step"
          }
        );
        await broadcastAgentSnapshot();
        return;
      }

      await this.appendChat(
        CHAT_MESSAGE_TYPES.TOOL_EVENT,
        `Running step ${runState.currentStepIndex + 1}/${plan.steps.length}: ${step.label}`
      );
      const result = await this.executeWithRecovery(step, runState, plan);
      if (result.status === "paused") {
        await broadcastAgentSnapshot();
        return;
      }

      const executedStep = result.executedStep || step;
      const nextOutputs = executedStep.outputKey
        ? { ...(runState.outputs || {}), [executedStep.outputKey]: result.output }
        : { ...(runState.outputs || {}) };

      await this.recordStepResult(executedStep, result);
      await this.maybePersistDomainMemory(executedStep, {
        ...runState,
        activeUrl: (await getCurrentRun()).activeUrl
      });
      await setCurrentRun({
        status: AGENT_RUN_STATUS.RUNNING,
        currentStepIndex: runState.currentStepIndex + 1,
        outputs: nextOutputs,
        error: "",
        awaitingApprovalStepId: null,
        pendingResolution: null,
        lastStepResult: {
          stepId: executedStep.id,
          label: executedStep.label,
          status: result.status,
          outputPreview: truncateText(result.output)
        }
      });
      await this.appendChat(
        CHAT_MESSAGE_TYPES.STEP_RESULT,
        `${executedStep.label} completed.`,
        {
          stepId: executedStep.id,
          outputPreview: truncateText(result.output)
        }
      );
      await broadcastAgentSnapshot();
      this.scheduleProcess();
    } catch (error) {
      await setCurrentRun({
        status: AGENT_RUN_STATUS.ERROR,
        error: error.message,
        pendingResolution: null,
        awaitingApprovalStepId: null
      });
      await this.appendChat(CHAT_MESSAGE_TYPES.ERROR_EVENT, error.message);
      await broadcastAgentSnapshot();
    } finally {
      this.processing = false;
    }
  }
}

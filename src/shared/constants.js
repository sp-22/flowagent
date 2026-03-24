export const OPENAI_API_URL = "https://api.openai.com/v1/responses";
export const LOG_LIMIT = 80;
export const MAX_DISCOVERED_POSTS_PER_QUERY = 20;
export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const DEFAULT_NVIDIA_MODEL = "meta/llama-3.1-8b-instruct";
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-20250514";
export const AGENT_CHAT_LOG_LIMIT = 120;

export const RUN_STATUS = {
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  COOLDOWN: "cooldown",
  AWAITING_USER: "awaiting_user",
  AWAITING_POST_CONFIRMATION: "awaiting_post_confirmation",
  COMPLETE: "complete",
  STOPPED: "stopped",
  ERROR: "error"
};

export const ITEM_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  READY: "ready",
  INSERTED: "inserted",
  POSTED: "posted",
  SKIPPED: "skipped",
  FAILED: "failed"
};

export const TIME_FILTERS = {
  LAST_24_HOURS: "last24h",
  LAST_WEEK: "lastWeek"
};

export const COMMENT_TONES = [
  "insightful",
  "friendly",
  "contrarian"
];

export const PLATFORM_IDS = {
  X: "x",
  LINKEDIN: "linkedin"
};

export const LLM_PROVIDER_IDS = {
  OPENAI: "openai",
  GEMINI: "gemini",
  NVIDIA: "nvidia",
  CLAUDE: "claude"
};

export const DEFAULT_SETTINGS = {
  queries: [],
  platforms: [PLATFORM_IDS.X, PLATFORM_IDS.LINKEDIN],
  timeFilter: TIME_FILTERS.LAST_24_HOURS,
  dailyTargetRange: {
    min: 20,
    max: 30
  },
  readingDelayRangeMs: {
    min: 2000,
    max: 5000
  },
  betweenDelayRangeMs: {
    min: 30000,
    max: 90000
  },
  typingDelayRangeMs: {
    min: 50,
    max: 120
  },
  tone: "insightful",
  insertionMode: "paste",
  skipChance: 0.12,
  llmAccounts: [],
  activeLlmAccountId: null,
  llmProvider: LLM_PROVIDER_IDS.OPENAI,
  model: DEFAULT_OPENAI_MODEL,
  apiBaseUrl: "",
  customPromptSuffix: "",
  apiKey: "",
  maxOutputTokens: 300
};

export const STORAGE_KEYS = {
  SETTINGS: "settings",
  RUN_STATE: "runState",
  QUEUE_ITEMS: "queueItems",
  DAILY_STATS: "dailyStats",
  ACTIVITY_LOG: "activityLog"
};

export const DEFAULT_RUN_STATE = {
  runId: null,
  status: RUN_STATUS.IDLE,
  pausedFrom: null,
  remainingDelayMs: 0,
  pickedDailyTarget: null,
  dailyTargetDate: null,
  activeTaskId: null,
  activePostTabId: null,
  activeSearchTabId: null,
  activeWindowId: null,
  queryCursor: 0,
  searchCursorPlatformIndex: 0,
  wakeAt: null,
  waitingReason: null,
  lastProcessedAt: null,
  errorMessage: "",
  startedAt: null
};

export const DEFAULT_DAILY_STATS = {
  dateKey: null,
  processed: 0,
  inserted: 0,
  posted: 0,
  skipped: 0
};

export const INTERNAL_ACTIONS = {
  RUN_GOOGLE_SEARCH: "RUN_GOOGLE_SEARCH_INTERNAL",
  DISCOVER_POSTS: "DISCOVER_POSTS_INTERNAL",
  EXTRACT_POST_CONTENT: "EXTRACT_POST_CONTENT_INTERNAL",
  INSERT_COMMENT_TEXT: "INSERT_COMMENT_TEXT_INTERNAL",
  CHECK_POST_CONFIRMATION: "CHECK_POST_CONFIRMATION_INTERNAL",
  ENSURE_COMMENT_CONTEXT: "ENSURE_COMMENT_CONTEXT_INTERNAL"
};

export const AGENT_STORAGE_KEYS = {
  CHAT_THREAD: "agentChatThread",
  COPILOT_THREAD: "agentCopilotThread",
  COPILOT_HISTORY: "agentCopilotHistory",
  COPILOT_STATE: "agentCopilotState",
  DRAFT_PLAN: "agentDraftPlan",
  CURRENT_RUN: "agentCurrentRun",
  SAVED_WORKFLOWS: "agentSavedWorkflows",
  STARTER_WORKFLOWS_SEEDED: "agentStarterWorkflowsSeeded",
  SESSION_MEMORY: "agentSessionMemory",
  USER_MEMORY: "agentUserMemory",
  DOMAIN_MEMORY: "agentDomainMemory",
  UI_STATE: "agentUiState"
};

export const CHAT_MESSAGE_TYPES = {
  USER_MESSAGE: "user_message",
  ASSISTANT_PLAN: "assistant_plan",
  ASSISTANT_QUESTION: "assistant_question",
  APPROVAL_REQUEST: "approval_request",
  TOOL_EVENT: "tool_event",
  STEP_RESULT: "step_result",
  ERROR_EVENT: "error_event",
  FINAL_RESULT: "final_result"
};

export const AGENT_TABS = {
  WORKFLOWS: "workflows",
  COPILOT: "copilot"
};

export const WORKFLOW_STEP_KINDS = [
  "open_url",
  "click",
  "type",
  "select_option",
  "wait_for",
  "extract_text",
  "extract_list",
  "scroll",
  "switch_tab",
  "close_tab",
  "summarize",
  "ask_user"
];

export const WORKFLOW_PLAN_STATUS = {
  DRAFT: "draft",
  APPROVED: "approved",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed"
};

export const AGENT_RUN_STATUS = {
  IDLE: "idle",
  NEEDS_PLAN_APPROVAL: "needs_plan_approval",
  RUNNING: "running",
  PAUSED: "paused",
  PAUSED_FOR_STEP_APPROVAL: "paused_for_step_approval",
  PAUSED_FOR_ERROR: "paused_for_error",
  COMPLETED: "completed",
  STOPPED: "stopped",
  ERROR: "error"
};

export const APPROVAL_MODES = {
  AUTO: "auto",
  ALWAYS: "always"
};

export const FAILURE_MODES = {
  STOP: "stop",
  REPAIR: "repair"
};

export const DEFAULT_AGENT_RUN_STATE = {
  runId: null,
  planId: null,
  sourceWorkflowId: null,
  sourceWorkflowTitle: "",
  status: AGENT_RUN_STATUS.IDLE,
  currentStepIndex: 0,
  awaitingApprovalStepId: null,
  activeTabId: null,
  activeUrl: "",
  outputs: {},
  error: "",
  startedAt: null,
  updatedAt: null,
  completedAt: null,
  approvedStepIds: [],
  openTabIds: [],
  lastStepResult: null,
  needsPermissionOrigins: [],
  pendingResolution: null,
  summary: ""
};

export const DEFAULT_SESSION_MEMORY = {
  currentPlanId: null,
  currentRunId: null,
  runs: {},
  history: [],
  recentFacts: []
};

export const DEFAULT_USER_MEMORY = {
  preferences: [],
  defaults: {},
  notes: [],
  updatedAt: null
};

export const DEFAULT_COPILOT_STATE = {
  activeConversationId: null
};

export const DEFAULT_AGENT_UI_STATE = {
  selectedTab: AGENT_TABS.WORKFLOWS,
  selectedWorkflowId: null,
  saveWorkflowDraft: null
};

export const STARTER_PROMPTS = [
  "Research a topic across multiple tabs and summarize the strongest findings.",
  "Collect structured data from a website and keep the useful fields in memory.",
  "Fill a repetitive browser workflow, but pause before anything risky is submitted."
];

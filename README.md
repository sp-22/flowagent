# FlowAgent

FlowAgent is a Chrome Manifest V3 extension for chat-first browser workflows. You describe a task in plain language, FlowAgent turns it into a bounded step plan, keeps approvals in the chat thread, and runs the workflow inside the browser with your own model keys.

## What It Is

- A sidepanel-first browser agent for structured web workflows
- Local-first and BYOK
- Chat UI for planning, approval, and execution updates
- Separate memory window so the main thread stays clean

## Current Scope

FlowAgent is focused on browser workflows, not general desktop automation.

Supported capabilities today:

- plan a workflow from natural language
- edit workflow steps inline
- approve, dismiss, run, pause, resume, or stop
- gate risky actions behind explicit approval
- execute bounded browser actions across tabs
- save reusable workflows and selector memory locally
- use multiple provider accounts and switch models from the top bar

## Product Surface

- `sidepanel.html / sidepanel.js / sidepanel.css`
  - Main chat-first interface
- `options.html / options.js / options.css`
  - Separate memory window for saved workflows, notes, and domain memory
- `src/background/service-worker.js`
  - Extension entrypoint and message router
- `src/background/agent-engine.js`
  - Planner/executor orchestration
- `src/content/page-tools.js`
  - Bounded browser actions injected on demand

## Workflow Model

Supported workflow step kinds:

- `open_url`
- `click`
- `type`
- `select_option`
- `wait_for`
- `extract_text`
- `extract_list`
- `scroll`
- `switch_tab`
- `close_tab`
- `summarize`
- `ask_user`

Each step is structured JSON. FlowAgent does not execute arbitrary model-generated code.

## Safety

- Full plan review before execution
- Risky browser actions require explicit user approval
- Site permissions are requested at runtime
- Memory stays in `chrome.storage.local`

## Model Providers

FlowAgent currently supports user-managed keys for:

- OpenAI
- Google Gemini
- Claude
- NVIDIA

The model picker only shows text LLMs relevant to planning and execution.

## Development

```bash
npm test
npm run build
```

Build output:

- unpacked extension: `dist/flowagent`
- zip package: `dist/flowagent.zip`

## Direction

The current direction is workflow-first browser automation:

- better planning
- better approval UX
- better memory
- stronger reusable workflows

Recorder, cloud sync, and non-browser automation are intentionally out of scope for now.

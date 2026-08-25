# Agent Continuity Entry Point

Read in order:

1. `AGENTS.md`
2. `docs/agent/PROJECT_KNOWLEDGE.md`
3. `docs/agent/INTEGRATIONS.md`
4. `docs/agent/HANDOFF.md`
5. The specific module or operations-agent brief named by those files

Maintain these records whenever work reveals a material command, environment-variable **name**, connector, endpoint, data source, constraint, decision, or unfinished implementation. Never record values, credentials, LAN addresses, hostnames, usernames, private paths, or private connection details in this public repository.

An incomplete handoff must include current state, affected files, tests run, exact failure/blocker, approval required, and one executable next action. A completed task must clear stale steps and state `Status: Complete — no active handoff`.

Operate autonomously for routine reversible repository work. Verify every connector with a harmless read. Follow the remote operations runbook for host actions, using secure host-local configuration. Pause for production/host deployment not explicitly authorized, destructive operations, source-system writes, credential/permission changes, auth changes, external sends, billing, or access outside the task.

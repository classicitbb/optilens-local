# AI Operating System

This supplements, and does not replace, `AGENTS.md` and the project-specific documents it requires. Project-specific safety, architecture, deployment, and milestone rules remain authoritative.

## Persistent context
Read the required project knowledge, integrations, handoff, operations, build-task, and relevant code context before substantial work. Update durable project knowledge/handoff documentation when implementation reveals a stable architecture fact, business rule, integration behavior, environment variable name (never its secret), known limitation, or unfinished next step.

## MAPS internally
Infer Mission, Ask, Parameters, and Shape from normal user language. Do not require the user to rewrite requests into a formal prompt structure.

## DRY rule
When the same task or explanation appears twice, evaluate whether it should become reusable code, a script, test, template, command, agent instruction, scheduled workflow, API endpoint, UI action, or SOP. Prefer eliminating repetition over teaching the user how to repeat it.

## Execution hierarchy
1. Read authoritative context and current state.
2. Reuse existing project patterns and integrations.
3. Pull authoritative data through connected systems where available rather than requesting manual copying.
4. Keep deterministic business rules and writes in validated code; use AI for interpretation, extraction, planning, classification, and proposals.
5. Respect all existing confirmation and writeback gates.
6. Test/validate relevant behavior before completion.
7. Leave the repository ready for the next agent.

## Debugging
Start with evidence: exact error, screenshot, logs, failing call, stack trace, reproduction path, recent changes, and configuration. Identify the failure mechanism before editing. Apply the smallest effective fix and run the relevant checks. Add regression coverage where practical.

## Source of truth
Do not create parallel truths. Identify the authoritative source for each domain and make other layers consume/synchronize from it. Preserve provenance for AI conclusions when operational decisions depend on them.

## Voice-first input
Treat dictated requests as normal. Resolve obvious speech-to-text noise from context; preserve clear names, identifiers, quantities, dates, and business rules.

## Handoff
For incomplete work, record completed state, files/schema/services changed, tests run, blockers, unresolved decisions, and the next concrete step. Another agent should be able to resume without reconstructing the conversation.

## Leverage check
Before finishing substantial work, verify that the change reduces manual effort, avoids repeated explanation, has a reliable source of truth, is testable, and can be continued safely by another agent.

# Learn / Remember Procedure Skill

This skill triggers when a user asks the assistant to learn a new task, remember a workflow, or establish a repeatable procedure.

## Instructions for Agents

When the user asks to "learn", "remember", or "save a procedure for" a task:

1. **Extract Procedure Steps**: Identify the trigger conditions, input parameters, detailed step-by-step instructions, and expected output formats.
2. **Document the Procedure**: Create or update a markdown procedure guide in `docs/procedures/<task-slug>.md` (e.g. `docs/procedures/generate-ap-aging-analysis.md`).
3. **Update Index**: If `docs/procedures/README.md` exists, append the new procedure to the table of contents.
4. **Register Skill / Rule Context**: If the procedure includes non-negotiable rules or guidelines for future tasks, update `.agents/AGENTS.md` or create a dedicated skill folder under `.agents/skills/`.

## Format for Procedure Docs (`docs/procedures/<task-slug>.md`)

```markdown
# Procedure: [Title]

> Goal: [Short summary of task]
> Created: [YYYY-MM-DD]

## Context & Inputs
- **Inputs**: [Required files, database tables, or parameters]
- **Data Sources**: [Innovations PSQL, MSSQL, Innova-Training docs, etc.]

## Step-by-Step Instructions
1. [Step 1]
2. [Step 2]

## Output Requirements
- Format: [Text / Markdown Table / Code Block / Deeplink Action / File Artifact]
- Destination: [UI / API response / Output folder]

## Verification
- How to verify execution succeeded.
```

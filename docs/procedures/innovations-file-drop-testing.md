# Procedure: Innovations File-Drop Controlled Testing

> Goal: Verify that a clearly synthetic stock order is delivered to the configured Innovations incoming folder and accepted by its watcher.
> Created: 2026-09-11

## Context & Inputs

- **Inputs:** An unlocked Credentials Vault with the Innovations incoming-folder entry, the installed stock-submission worker, and the host checkout.
- **Data source:** The test Innovations intake only.
- **Authorization:** The user granted autonomous execution for this testing scenario. This does not extend to production changes, credential or permission changes, or non-test external sends.

## Step-by-Step Instructions

1. Verify that the vault folder resolves, is reachable from the host process, and that the stock-submission task is ready.
2. Run `node scripts/test-stock-release.js` from the authoritative host checkout.
3. The script stages and releases exactly one stock file marked `OPTILENS TEST DO NOT PROCESS`, with no generated customer PO value.
4. Wait for the script's watcher check to report the final intake outcome. If it is pending, retain that one test file and use a read-only follow-up; do not submit another test file.

## Output Requirements

- **Format:** Console result plus local generator/audit logs.
- **Destination:** The vault-configured Innovations incoming folder.
- **Success criterion:** `Innova intake outcome: accepted`.

## Verification

If the outcome is `rejected`, retain the file name and local logs, do not retry automatically, and inspect the rejected file under the approved test-system process. If it is `pending`, wait for the normal watcher window and perform a read-only follow-up check.

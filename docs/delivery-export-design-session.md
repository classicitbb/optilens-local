# Delivery and Export Module Design Session

Date: 2026-06-03

## Purpose

This module replaces the Access export shipment workflow, but it runs as one module inside the larger OptiLens Local platform.

The current web screen is only the first working shell. The next build must replace placeholder fields with real source-driven lists and source-driven shipment item loading.

## Current State

Built and working:

- Platform launch page.
- Health API.
- Private MSSQL app database connection.
- Platform module registry.
- Access backend import dry-run.
- App-owned shipment session table.
- App-owned close/reopen/event trail for shipment sessions.

Not done yet:

- Dispatcher dropdown from source tracking users.
- CustomerAccount list from source customer table.
- CustomerAccount constrained to export/shipping customers.
- Source `ShipmentItems` preload by `CustomerAccount` and `ShipmentID`.
- Invoice scan lookup.
- Commercial invoice generation.
- Authenticated role-based editing.

## Data Sources For Next Build

### Dispatcher Dropdown

Requirement:

- Dispatcher dropdown should be loaded from the source SQL tracking users table.

Confirmed source:

- Source MSSQL `Innovations`
- Table: `dbo.UserAccounts`
- Safe fields for app use: `UserAccountID`, `UserName`, `DisplayName`, `FirstName`, `LastName`, `JobTitle`, `Active`
- Do not query or expose authentication/hash fields.

Current initial filter:

- `Active = 1`
- Candidate dispatchers where job title, username, or display name indicates shipping/courier/inventory.
- This filter should be validated by staff because not every active source user is a dispatcher.

Initial intended API:

```text
GET /api/source/dispatchers
```

Initial intended behavior:

- Read-only source query.
- Return ID and display name.
- Cache briefly if needed.
- Do not store source users as platform users unless explicitly mapped later.

### CustomerAccount Dropdown

Requirement:

- Customer list should come from the source customer table.
- Constrain to `ShippingMethodID = 16`.

Confirmed source:

- Source MSSQL `Innovations`
- Table: `dbo.Customers`
- Filter: `ShippingMethodID = 16`
- Account value: `AccountNumber`
- Display value: `CustomerName`
- Active filter: `IsActive = 1`

Needed confirmation:

- Whether `ShippingMethodID = 16` means all export customers or only this workflow's default export group.

Initial intended API:

```text
GET /api/source/export-customers
```

Initial intended behavior:

- Read-only source query.
- Searchable customer dropdown.
- Store selected `CustomerAccount` on the app-owned shipment session.

### Shipment Item Preload

Requirement:

- After customer and shipment are selected, load items from source `ShipmentItems`.
- Staff can add/remove items in the app before generating documents.
- App-owned close/reopen edits do not update source `Shipments.Shipped` yet.

Confirmed source tables:

- MSSQL `Innovations.dbo.Shipments`
- MSSQL `Innovations.dbo.ShipmentItems`
- MSSQL `Innovations.dbo.Orders`
- MSSQL `Innovations.dbo.Invoices`

Initial join:

- `ShipmentItems.ShipmentID` -> `Shipments.ShipmentID`
- `ShipmentItems.OrderID` -> `Orders.OrderID`
- `Invoices.OrderID` -> `Orders.OrderID`
- `Orders.CustomerAccount` filtered to selected customer account.
- `Orders.PatientID` used for patient display.
- `Invoices.Total` used for price display.

Initial intended API:

```text
GET /api/source/shipment-items?customerAccount=...&shipmentId=...
```

Needed confirmation:

- Whether source should be MSSQL first, PSQL first, or fallback between both.
- Whether `ShipmentID` comes from scanning/selecting a shipment or from a source open-shipment list.
- Whether `Invoices.Total` is the right price when multiple invoices exist for one order.

## Source Access Required

To build the real dropdowns and preload behavior, we need read-only access to the source `Innovations` database from the app.

Current app DB access is working, but source DB access is not wired yet.

Needed safe setup:

- Source MSSQL server: `MSSQL-SVR`
- Source database: `Innovations`
- Read-only source login or service account.
- Environment variables for source credentials, not committed to code.

Recommended source environment variables:

```text
OPTILENS_SOURCE_MSSQL_USER=read_only_user
OPTILENS_SOURCE_MSSQL_PASSWORD=secret_not_in_repo
```

## Design Decision

Proceed in this order:

1. Hold this design baseline.
2. Wire read-only source MSSQL access.
3. Add source schema discovery endpoints for `dbo.Users`, `dbo.Customers`, `dbo.Shipments`, and `dbo.ShipmentItems`.
4. Confirm exact columns from live schema.
5. Build real dispatcher and customer dropdown APIs.
6. Replace placeholder screen controls with source-backed dropdown/search controls.
7. Build shipment item preload.
8. Keep app-owned close/reopen/edit state in `optilens_local`.
9. Add authentication after the basic workflow is validated.

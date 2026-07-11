# CV Web live-data API guide

## Architecture

OptiLens Local is the only process that reads `MSSQL-SVR/Innovations`.

CV Web never calls the office network directly. It queues an authenticated,
customer-scoped request in Supabase. The OptiLens Local live gateway polls the
queue outbound over HTTPS, reads the approved data from MSSQL, and posts the
response back to CV Web.

The active private-source operations are:

- `innovations.customer_account`: balance plus recent posted statement headers.
- `innovations.customer_statement`: one statement header plus visible statement items.
- `innovations.customer_orders`: recent Innovations orders, invoices, status, Rx number, patient, tray, shipping/reference fields.
- `optilens.customer_deliveries`: OptiLens Local delivery sessions and tracking.

InnovaAPI is not used by this flow.

## CV Web setup

1. Deploy the latest CV Web Supabase migrations, including:
   - `20260710170000_live_data_gateway.sql`
   - `20260711090000_portal_statement_and_rx_status.sql`
   - `20260711110000_mssql_gateway_orders_and_account_guard.sql`

2. Deploy the Supabase functions:
   - `live-data-gateway`
   - `innovations-sync`
   - `api-v1`

3. Create or update the API key used by OptiLens Local. It needs these scopes:
   - `gateway:agent`
   - `customers:write`
   - `contacts:write`
   - `statements:write`
   - `balances:write`
   - `catalog:read`
   - `catalog:write` if the pricelist publisher is used

4. Check account-number duplicates before relying on portal statement/order links:

```sql
select * from public.customer_account_number_duplicates;
```

Every nonblank `public.customers.account_number` must map to only one customer.
The migration blocks new duplicates. If existing duplicates are present, resolve
them in CV Web admin, then rerun the migration to create the hard normalized
unique index.

## OptiLens Local setup

1. Confirm `.env` or the credentials vault has the MSSQL source connection:

```text
OPTILENS_SOURCE_MSSQL_SERVER=MSSQL-SVR
OPTILENS_SOURCE_MSSQL_DATABASE=Innovations
OPTILENS_SOURCE_MSSQL_USER=<read-only sql login>
OPTILENS_SOURCE_MSSQL_PASSWORD=<secret>
OPTILENS_SOURCE_MSSQL_ENCRYPT=true
OPTILENS_SOURCE_MSSQL_TRUST_CERT=true
```

2. Open OptiLens Local:

```text
http://127.0.0.1:8080/integrations
```

3. Go to `Website feeds`, enter the connector vault passphrase, and start the
live gateway.

4. Use `Dry run` first for:
   - Customers
   - Contacts
   - Balances
   - Statements
   - Statement lines

5. If the dry run is clean, run `Sync now`. For the first historical statement
backfill, check `Suppress statement emails (backfill)`.

6. Use the `Sync logs` tab to watch local entity reads, upserts, failures, and
cloud queue processing.

## Verification

Local health:

```text
http://127.0.0.1:8080/api/health
http://127.0.0.1:8080/api/connectors/live-gateway/status
```

CV Web function version checks:

```text
https://<project-ref>.supabase.co/functions/v1/live-data-gateway
https://<project-ref>.supabase.co/functions/v1/innovations-sync/version
https://<project-ref>.supabase.co/functions/v1/api-v1
```

Portal checks:

- Customer has `customers.account_number` set to the exact Innovations account number.
- Customer has the `private-orders` feature enabled to see live order/delivery status.
- Customer has the `statements` feature enabled to see balance/statements.
- Opening `/profile/statements` should request `innovations.customer_account`, then `innovations.customer_statement`.
- Opening `/profile/orders` should request `innovations.customer_orders` and `optilens.customer_deliveries`.

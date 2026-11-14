IF OBJECT_ID(N'qbo.local_customers', N'U') IS NULL
CREATE TABLE qbo.local_customers (
    customer_id uniqueidentifier NOT NULL PRIMARY KEY DEFAULT NEWID(),
    account nvarchar(120) NOT NULL UNIQUE,
    customer_name nvarchar(300) NOT NULL,
    innovations_id int NULL,
    origin nvarchar(20) NOT NULL,
    actor_user_id uniqueidentifier NULL,
    innovations_state nvarchar(20) NOT NULL DEFAULT N'pending',
    innovations_error nvarchar(500) NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'qbo.local_customers') AND name=N'UX_local_customers_innovations')
CREATE UNIQUE INDEX UX_local_customers_innovations ON qbo.local_customers(innovations_id) WHERE innovations_id IS NOT NULL;

IF OBJECT_ID(N'qbo.customer_jobs', N'U') IS NULL
CREATE TABLE qbo.customer_jobs (
    realm_id nvarchar(80) NOT NULL,
    customer_id uniqueidentifier NOT NULL REFERENCES qbo.local_customers(customer_id),
    sync_state nvarchar(20) NOT NULL DEFAULT N'pending',
    last_error nvarchar(500) NULL,
    last_checked_at datetime2 NULL,
    PRIMARY KEY (realm_id, customer_id)
);

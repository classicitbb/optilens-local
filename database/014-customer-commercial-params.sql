USE [optilens_local];
GO

IF OBJECT_ID(N'delivery.customer_commercial_params', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.customer_commercial_params (
        customer_commercial_param_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_ccp_id DEFAULT NEWID(),
        customer_account nvarchar(120) NOT NULL,
        port_of_discharge nvarchar(200) NULL,
        delivery_terms nvarchar(200) NULL,
        bank_name nvarchar(300) NULL,
        bank_account_name nvarchar(300) NULL,
        bank_account_number nvarchar(120) NULL,
        bank_swift_bic nvarchar(60) NULL,
        bank_routing_number nvarchar(60) NULL,
        bank_branch_address nvarchar(500) NULL,
        notes nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_ccp_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NULL,
        updated_by_user_id uniqueidentifier NULL,
        CONSTRAINT PK_delivery_customer_commercial_params PRIMARY KEY (customer_commercial_param_id)
    );
END;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'UQ_delivery_ccp_account'
      AND object_id = OBJECT_ID(N'delivery.customer_commercial_params')
)
BEGIN
    CREATE UNIQUE INDEX UQ_delivery_ccp_account
        ON delivery.customer_commercial_params(customer_account);
END;
GO

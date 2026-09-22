USE [optilens_local];
GO

IF COL_LENGTH(N'rx_capture.orders', N'customer_id') IS NULL
    ALTER TABLE rx_capture.orders ADD customer_id int NULL;
GO

IF COL_LENGTH(N'rx_capture.orders', N'customer_account') IS NULL
    ALTER TABLE rx_capture.orders ADD customer_account nvarchar(80) NULL;
GO

IF COL_LENGTH(N'rx_capture.orders', N'customer_name') IS NULL
    ALTER TABLE rx_capture.orders ADD customer_name nvarchar(300) NULL;
GO

IF COL_LENGTH(N'rx_capture.orders', N'review_confirmed_at') IS NULL
    ALTER TABLE rx_capture.orders ADD review_confirmed_at datetime2(0) NULL;
GO

IF COL_LENGTH(N'rx_capture.orders', N'review_confirmed_by') IS NULL
    ALTER TABLE rx_capture.orders ADD review_confirmed_by uniqueidentifier NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_rx_capture_orders_review_confirmed_by')
    ALTER TABLE rx_capture.orders ADD CONSTRAINT FK_rx_capture_orders_review_confirmed_by
      FOREIGN KEY (review_confirmed_by) REFERENCES core.users(user_id);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_rx_capture_orders_customer' AND object_id = OBJECT_ID(N'rx_capture.orders'))
    CREATE INDEX IX_rx_capture_orders_customer ON rx_capture.orders (customer_account, created_at DESC);
GO

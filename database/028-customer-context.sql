USE [optilens_local];
GO

IF COL_LENGTH(N'ops.SupplierRecords', N'customer_id') IS NULL
    ALTER TABLE ops.SupplierRecords ADD customer_id int NULL;
IF COL_LENGTH(N'ops.SupplierRecords', N'customer_name') IS NULL
    ALTER TABLE ops.SupplierRecords ADD customer_name nvarchar(220) NULL;
GO

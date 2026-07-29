USE [optilens_local];
GO

IF COL_LENGTH(N'ops.SupplierRecords', N'patient_id') IS NULL
    ALTER TABLE ops.SupplierRecords ADD patient_id nvarchar(300) NULL;
IF COL_LENGTH(N'ops.SupplierRecords', N'customer_account') IS NULL
    ALTER TABLE ops.SupplierRecords ADD customer_account nvarchar(120) NULL;
IF COL_LENGTH(N'ops.SupplierRecords', N'received_at') IS NULL
    ALTER TABLE ops.SupplierRecords ADD received_at datetime2(3) NULL;
GO

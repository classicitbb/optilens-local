USE [optilens_local];
GO

IF COL_LENGTH(N'ops.SupplierRecords', N'patient_id') IS NULL
    ALTER TABLE ops.SupplierRecords ADD patient_id nvarchar(300) NULL;
IF COL_LENGTH(N'ops.SupplierRecords', N'patient_name') IS NOT NULL
    UPDATE ops.SupplierRecords
    SET patient_id = COALESCE(patient_id, patient_name)
    WHERE patient_id IS NULL;
GO

USE [optilens_local];
GO

IF COL_LENGTH(N'delivery.co_item_catalog', N'short_name') IS NULL
    ALTER TABLE delivery.co_item_catalog ADD short_name nvarchar(300) NULL;
GO

IF COL_LENGTH(N'delivery.co_item_catalog', N'certificate_eligible') IS NULL
    ALTER TABLE delivery.co_item_catalog ADD certificate_eligible bit NULL;
GO

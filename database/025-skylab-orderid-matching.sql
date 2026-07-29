USE [optilens_local];
GO

UPDATE ops.SupplierRules
SET matching_field = N'order_id',
    notes = N'SkyLab reference is matched directly to dbo.Orders.OrderID; confirm status mapping before enabling.',
    updated_at = SYSUTCDATETIME()
WHERE rule_code = N'skylab-shipped';
GO

IF COL_LENGTH(N'delivery.commercial_invoice_custom_lines', N'include_in_certificate') IS NULL
BEGIN
    ALTER TABLE delivery.commercial_invoice_custom_lines
        ADD include_in_certificate bit NOT NULL CONSTRAINT DF_delivery_commercial_invoice_custom_lines_cert DEFAULT 0;
END;
GO

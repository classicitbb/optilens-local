IF OBJECT_ID(N'delivery.commercial_invoice_line_overrides', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.commercial_invoice_line_overrides (
        commercial_invoice_line_override_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_commercial_invoice_line_overrides_id DEFAULT NEWID(),
        shipment_session_id uniqueidentifier NOT NULL,
        line_key nvarchar(120) NOT NULL,
        line_number_text nvarchar(40) NULL,
        ref_text nvarchar(200) NULL,
        specification_text nvarchar(max) NULL,
        hs_code_text nvarchar(80) NULL,
        origin_text nvarchar(120) NULL,
        quantity_text nvarchar(80) NULL,
        unit_price_text nvarchar(80) NULL,
        amount_text nvarchar(80) NULL,
        created_by_user_id uniqueidentifier NULL,
        updated_by_user_id uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_commercial_invoice_line_overrides_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_commercial_invoice_line_overrides_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_delivery_commercial_invoice_line_overrides PRIMARY KEY (commercial_invoice_line_override_id),
        CONSTRAINT UQ_delivery_commercial_invoice_line_overrides_session_line UNIQUE (shipment_session_id, line_key),
        CONSTRAINT FK_delivery_commercial_invoice_line_overrides_session FOREIGN KEY (shipment_session_id) REFERENCES delivery.shipment_sessions(shipment_session_id)
    );
END;
GO

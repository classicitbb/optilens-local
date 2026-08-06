IF OBJECT_ID(N'delivery.commercial_invoice_header_overrides', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.commercial_invoice_header_overrides (
        shipment_session_id uniqueidentifier NOT NULL,
        customer_order_no_text nvarchar(200) NULL,
        po_numbers_text nvarchar(200) NULL,
        carrier_text nvarchar(120) NULL,
        marks_and_numbers_text nvarchar(200) NULL,
        port_of_loading_text nvarchar(200) NULL,
        package_type_text nvarchar(200) NULL,
        declaration_text nvarchar(max) NULL,
        gross_weight_lbs_text nvarchar(40) NULL,
        created_by_user_id uniqueidentifier NULL,
        updated_by_user_id uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_ci_header_overrides_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_ci_header_overrides_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_delivery_commercial_invoice_header_overrides PRIMARY KEY (shipment_session_id),
        CONSTRAINT FK_delivery_ci_header_overrides_session FOREIGN KEY (shipment_session_id) REFERENCES delivery.shipment_sessions(shipment_session_id)
    );
END;
GO

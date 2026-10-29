-- Marks an invoice whose tariff selection has been confirmed by a person, so an
-- intentionally empty selection is not refilled from the invoice line HS codes.
IF OBJECT_ID(N'delivery.commercial_invoice_tariff_state', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.commercial_invoice_tariff_state (
        shipment_session_id uniqueidentifier NOT NULL,
        saved_by_user_id uniqueidentifier NULL,
        saved_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_ci_tariff_state_saved DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_delivery_commercial_invoice_tariff_state PRIMARY KEY (shipment_session_id),
        CONSTRAINT FK_delivery_ci_tariff_state_session FOREIGN KEY (shipment_session_id) REFERENCES delivery.shipment_sessions(shipment_session_id)
    );
    -- Invoices that already carry saved tariffs count as confirmed.
    INSERT INTO delivery.commercial_invoice_tariff_state (shipment_session_id)
    SELECT DISTINCT shipment_session_id FROM delivery.commercial_invoice_tariffs;
END;
GO

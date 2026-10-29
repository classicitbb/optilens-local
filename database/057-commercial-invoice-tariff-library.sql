IF OBJECT_ID(N'delivery.tariff_codes', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.tariff_codes (
        tariff_id uniqueidentifier NOT NULL CONSTRAINT DF_delivery_tariff_codes_id DEFAULT NEWID(),
        tariff_code nvarchar(40) NOT NULL,
        description nvarchar(500) NOT NULL,
        search_aliases nvarchar(1000) NULL,
        verification_status nvarchar(20) NOT NULL CONSTRAINT DF_delivery_tariff_codes_verification DEFAULT N'unverified',
        is_active bit NOT NULL CONSTRAINT DF_delivery_tariff_codes_active DEFAULT 1,
        is_pinned bit NOT NULL CONSTRAINT DF_delivery_tariff_codes_pinned DEFAULT 0,
        display_order int NOT NULL CONSTRAINT DF_delivery_tariff_codes_order DEFAULT 0,
        created_by_user_id uniqueidentifier NULL,
        updated_by_user_id uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_tariff_codes_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_tariff_codes_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_delivery_tariff_codes PRIMARY KEY (tariff_id),
        CONSTRAINT CK_delivery_tariff_codes_verification CHECK (verification_status IN (N'verified', N'unverified'))
    );
    CREATE UNIQUE INDEX UX_delivery_tariff_codes_code ON delivery.tariff_codes (tariff_code);
END;
GO
-- Invoice-level snapshots. Code and description are copied here so a later
-- edit, deactivation or deletion of the library entry never changes an invoice.
-- tariff_id is deliberately not a foreign key: it only records provenance and
-- is what blocks deleting a library entry that an invoice has used.
IF OBJECT_ID(N'delivery.commercial_invoice_tariffs', N'U') IS NULL
BEGIN
    CREATE TABLE delivery.commercial_invoice_tariffs (
        shipment_session_id uniqueidentifier NOT NULL,
        position int NOT NULL,
        tariff_id uniqueidentifier NULL,
        tariff_code nvarchar(40) NOT NULL,
        description nvarchar(500) NOT NULL,
        created_by_user_id uniqueidentifier NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_delivery_ci_tariffs_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_delivery_commercial_invoice_tariffs PRIMARY KEY (shipment_session_id, position),
        CONSTRAINT FK_delivery_ci_tariffs_session FOREIGN KEY (shipment_session_id) REFERENCES delivery.shipment_sessions(shipment_session_id)
    );
    CREATE INDEX IX_delivery_ci_tariffs_tariff ON delivery.commercial_invoice_tariffs (tariff_id);
END;
GO
-- Seed only entries that do not exist yet, so administrator edits survive re-runs.
-- (Match on code: an admin who recoded an entry will see the original re-seeded.)
;WITH seed (tariff_code, description, search_aliases, display_order) AS (
    SELECT * FROM (VALUES
        (N'9001.50.00.000', N'Rx Spectacle Lenses – Uncut, Plastic and Other Materials', N'lenses, rx, uncut, semi-finished, finished lenses', 10),
        (N'9004.90.00.000', N'Spectacles and Corrective Eyewear', N'spectacles, prescription glasses, eyewear', 20),
        (N'9004.50.00.000', N'Legacy Eyewear Classification – Verification Required', N'legacy, eyewear', 30),
        (N'3405.90', N'Lens Polishing Compounds and Preparations', N'polish, polishing compound, lab polish', 40),
        (N'3402.90.10', N'Lens Marking Remover – Eliminator', N'eliminator, marking remover, cleaning solution', 50),
        (N'3919.90.50.60', N'Adhesive Lab Supplies', N'adhesive, lab supplies, tape', 60),
        (N'6804.21.00.000', N'Diamond Abrasive Polishing Pads', N'diamond pads, polishing pads', 70),
        (N'6804.22.00.000', N'Other Abrasive Polishing Pads', N'polish pads, abrasives', 80),
        (N'6307.10.00.000', N'Lens Cleaning Cloths', N'microfiber, cloths, cleaning cloths', 90),
        (N'8466.93.00.000', N'Optical Edging Machine Chucks', N'edging chucks, machine parts, edger', 100),
        (N'9608.10.00.00', N'Ballpoint Pens / Marking Instruments', N'pens, marking instruments', 110)
    ) v (tariff_code, description, search_aliases, display_order)
)
INSERT INTO delivery.tariff_codes (tariff_code, description, search_aliases, verification_status, display_order)
SELECT s.tariff_code, s.description, s.search_aliases, N'unverified', s.display_order
FROM seed s
WHERE NOT EXISTS (SELECT 1 FROM delivery.tariff_codes t WHERE t.tariff_code = s.tariff_code);
GO

USE [optilens_local];
GO

IF OBJECT_ID(N'rx_capture.innovations_account_mappings', N'U') IS NULL
BEGIN
    CREATE TABLE rx_capture.innovations_account_mappings (
        customer_account nvarchar(80) NOT NULL,
        innovations_customer_number nvarchar(40) NOT NULL,
        source_name nvarchar(80) NOT NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_rx_capture_innovations_account_mappings_created DEFAULT SYSUTCDATETIME(),
        updated_at datetime2(0) NOT NULL CONSTRAINT DF_rx_capture_innovations_account_mappings_updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_rx_capture_innovations_account_mappings PRIMARY KEY (customer_account)
    );
END;
GO

-- Verified LabLink mapping supplied for the RX Capture workflow. Other accounts
-- remain deliberately unmapped until their existing LabLink number is confirmed.
IF NOT EXISTS (SELECT 1 FROM rx_capture.innovations_account_mappings WHERE customer_account = N'EFI')
    INSERT INTO rx_capture.innovations_account_mappings (customer_account, innovations_customer_number, source_name)
    VALUES (N'EFI', N'5000189', N'LabLink');
GO

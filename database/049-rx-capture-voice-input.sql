USE [optilens_local];
GO

-- Voice or typed intake. input_mode is photo, manual, voice (at least one clip
-- was transcribed) or text (typed only). The raw transcript and the checked,
-- segmented transcript the extractor read are kept with the order; audio is not.
IF COL_LENGTH(N'rx_capture.orders', N'input_mode') IS NULL
    ALTER TABLE rx_capture.orders ADD input_mode nvarchar(20) NULL;
GO

IF COL_LENGTH(N'rx_capture.orders', N'transcript_raw_json') IS NULL
    ALTER TABLE rx_capture.orders ADD transcript_raw_json nvarchar(max) NULL;
GO

IF COL_LENGTH(N'rx_capture.orders', N'transcript_edited_json') IS NULL
    ALTER TABLE rx_capture.orders ADD transcript_edited_json nvarchar(max) NULL;
GO

USE [optilens_local];
GO

-- Saved signatures per mailbox. Anyone who can read the mailbox can choose one
-- in compose; its owner or an admin adds, edits and picks the default. At most
-- one default per mailbox (filtered unique index).
IF OBJECT_ID(N'mail.signatures', N'U') IS NULL
CREATE TABLE mail.signatures (
    signature_id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_mail_signatures PRIMARY KEY,
    account_code nvarchar(60) NOT NULL CONSTRAINT FK_mail_signatures_account REFERENCES mail.accounts(account_code) ON DELETE CASCADE,
    name nvarchar(100) NOT NULL,
    body_html nvarchar(max) NOT NULL,
    is_default bit NOT NULL CONSTRAINT DF_mail_signatures_default DEFAULT 0,
    updated_by_email nvarchar(320) NULL,
    created_at datetime2(0) NOT NULL CONSTRAINT DF_mail_signatures_created DEFAULT SYSUTCDATETIME(),
    updated_at datetime2(0) NOT NULL CONSTRAINT DF_mail_signatures_updated DEFAULT SYSUTCDATETIME()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_mail_signatures_default' AND object_id = OBJECT_ID(N'mail.signatures'))
CREATE UNIQUE INDEX UX_mail_signatures_default ON mail.signatures(account_code) WHERE is_default = 1;
GO

-- Formatted sends are logged like plain ones; record which kind went out.
IF COL_LENGTH(N'mail.send_log', N'is_html') IS NULL
ALTER TABLE mail.send_log ADD is_html bit NOT NULL CONSTRAINT DF_mail_send_log_is_html DEFAULT 0;
GO

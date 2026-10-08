USE [optilens_local];
GO

-- One row per connected mailbox (~15 staff mailboxes plus shared ones such as
-- orders@). Shared mailboxes are visible to every admin/operator; personal
-- mailboxes only to their members. Passwords are DPAPI-protected on this host
-- (protected_password) or, for legacy shared boxes, read from the Credentials
-- Vault (credential_source = 'vault').
IF OBJECT_ID(N'mail.accounts', N'U') IS NULL
CREATE TABLE mail.accounts (
    account_code nvarchar(60) NOT NULL CONSTRAINT PK_mail_accounts PRIMARY KEY,
    address nvarchar(320) NOT NULL CONSTRAINT UQ_mail_accounts_address UNIQUE,
    display_name nvarchar(200) NOT NULL,
    is_shared bit NOT NULL CONSTRAINT DF_mail_accounts_shared DEFAULT 0,
    imap_host nvarchar(260) NOT NULL,
    imap_port int NOT NULL CONSTRAINT DF_mail_accounts_imap_port DEFAULT 993,
    imap_secure bit NOT NULL CONSTRAINT DF_mail_accounts_imap_secure DEFAULT 1,
    smtp_host nvarchar(260) NULL,
    smtp_port int NULL,
    smtp_secure bit NULL,
    username nvarchar(320) NOT NULL,
    credential_source nvarchar(20) NOT NULL CONSTRAINT DF_mail_accounts_cred_source DEFAULT N'stored',
    protected_password nvarchar(max) NULL,
    is_enabled bit NOT NULL CONSTRAINT DF_mail_accounts_enabled DEFAULT 1,
    last_sync_at datetime2(0) NULL,
    last_error nvarchar(1000) NULL,
    created_by_email nvarchar(320) NULL,
    created_at datetime2(0) NOT NULL CONSTRAINT DF_mail_accounts_created DEFAULT SYSUTCDATETIME(),
    updated_at datetime2(0) NOT NULL CONSTRAINT DF_mail_accounts_updated DEFAULT SYSUTCDATETIME()
);
GO

-- Who can open a personal mailbox. Keyed by the OpticAdmin sign-in email.
IF OBJECT_ID(N'mail.account_members', N'U') IS NULL
CREATE TABLE mail.account_members (
    account_code nvarchar(60) NOT NULL CONSTRAINT FK_mail_account_members_account REFERENCES mail.accounts(account_code) ON DELETE CASCADE,
    user_email nvarchar(320) NOT NULL,
    role nvarchar(10) NOT NULL, -- owner, member
    added_by_email nvarchar(320) NULL,
    added_at datetime2(0) NOT NULL CONSTRAINT DF_mail_account_members_added DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_mail_account_members PRIMARY KEY (account_code, user_email)
);
GO

-- The orders@ mailbox synced since migration 050 becomes the first shared account.
IF NOT EXISTS (SELECT 1 FROM mail.accounts WHERE account_code = N'orders')
INSERT INTO mail.accounts (account_code, address, display_name, is_shared, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, credential_source)
SELECT TOP 1 N'orders', LOWER(mailbox_username), N'Orders', 1, server_hostname, ISNULL(port, 993), ISNULL(ssl_enabled, 1),
       server_hostname, 465, 1, mailbox_username, N'vault'
FROM ops.MailboxConfigurations WHERE configuration_code = N'classic-visions-orders';
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_mail_folders_account')
   AND NOT EXISTS (SELECT 1 FROM mail.folders f WHERE NOT EXISTS (SELECT 1 FROM mail.accounts a WHERE a.account_code = f.account_code))
ALTER TABLE mail.folders ADD CONSTRAINT FK_mail_folders_account FOREIGN KEY (account_code) REFERENCES mail.accounts(account_code) ON DELETE CASCADE;
GO

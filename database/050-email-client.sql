USE [optilens_local];
GO

-- Email client (OpticAdmin /admin/email). A read-mostly mirror of company IMAP
-- mailboxes: the mail server stays the system of record, these tables are a
-- cache the sync rebuilds. message_addresses lets the CRM look up every email
-- to or from a contact without parsing JSON.
IF SCHEMA_ID(N'mail') IS NULL EXEC(N'CREATE SCHEMA mail');
GO

IF OBJECT_ID(N'mail.folders', N'U') IS NULL
CREATE TABLE mail.folders (
    folder_id int IDENTITY(1,1) NOT NULL CONSTRAINT PK_mail_folders PRIMARY KEY,
    account_code nvarchar(60) NOT NULL,
    path nvarchar(400) NOT NULL,
    display_name nvarchar(200) NOT NULL,
    special_use nvarchar(40) NULL,
    uid_validity bigint NULL,
    last_synced_at datetime2(0) NULL,
    CONSTRAINT UQ_mail_folders_account_path UNIQUE (account_code, path)
);
GO

IF OBJECT_ID(N'mail.messages', N'U') IS NULL
CREATE TABLE mail.messages (
    message_id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_mail_messages PRIMARY KEY,
    folder_id int NOT NULL CONSTRAINT FK_mail_messages_folder REFERENCES mail.folders(folder_id) ON DELETE CASCADE,
    uid bigint NOT NULL,
    internet_message_id nvarchar(998) NULL,
    in_reply_to nvarchar(998) NULL,
    references_header nvarchar(max) NULL,
    subject nvarchar(998) NULL,
    from_address nvarchar(320) NULL,
    from_name nvarchar(320) NULL,
    to_json nvarchar(max) NULL,
    cc_json nvarchar(max) NULL,
    sent_at datetime2(0) NULL,
    is_read bit NOT NULL CONSTRAINT DF_mail_messages_is_read DEFAULT 0,
    is_flagged bit NOT NULL CONSTRAINT DF_mail_messages_is_flagged DEFAULT 0,
    has_attachments bit NOT NULL CONSTRAINT DF_mail_messages_has_attachments DEFAULT 0,
    snippet nvarchar(300) NULL,
    body_text nvarchar(max) NULL,
    body_html nvarchar(max) NULL,
    synced_at datetime2(0) NOT NULL CONSTRAINT DF_mail_messages_synced_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_mail_messages_folder_uid UNIQUE (folder_id, uid)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_mail_messages_folder_sent' AND object_id = OBJECT_ID(N'mail.messages'))
CREATE INDEX IX_mail_messages_folder_sent ON mail.messages (folder_id, sent_at DESC);
GO

IF OBJECT_ID(N'mail.message_addresses', N'U') IS NULL
CREATE TABLE mail.message_addresses (
    message_id bigint NOT NULL CONSTRAINT FK_mail_message_addresses_message REFERENCES mail.messages(message_id) ON DELETE CASCADE,
    address nvarchar(320) NOT NULL,
    role nvarchar(4) NOT NULL, -- from, to, cc
    CONSTRAINT PK_mail_message_addresses PRIMARY KEY (message_id, address, role)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_mail_message_addresses_address' AND object_id = OBJECT_ID(N'mail.message_addresses'))
CREATE INDEX IX_mail_message_addresses_address ON mail.message_addresses (address) INCLUDE (role);
GO

IF OBJECT_ID(N'mail.attachments', N'U') IS NULL
CREATE TABLE mail.attachments (
    attachment_id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_mail_attachments PRIMARY KEY,
    message_id bigint NOT NULL CONSTRAINT FK_mail_attachments_message REFERENCES mail.messages(message_id) ON DELETE CASCADE,
    filename nvarchar(400) NOT NULL,
    content_type nvarchar(200) NULL,
    size_bytes bigint NOT NULL CONSTRAINT DF_mail_attachments_size DEFAULT 0,
    storage_path nvarchar(800) NOT NULL
);
GO

-- Who sent what from OpticAdmin. The sent message itself is appended to the
-- mailbox's Sent folder and synced back like any other message.
IF OBJECT_ID(N'mail.send_log', N'U') IS NULL
CREATE TABLE mail.send_log (
    send_id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_mail_send_log PRIMARY KEY,
    account_code nvarchar(60) NOT NULL,
    sent_by_user_id nvarchar(64) NULL,
    sent_by_email nvarchar(320) NULL,
    to_list nvarchar(max) NOT NULL,
    subject nvarchar(998) NULL,
    internet_message_id nvarchar(998) NULL,
    attachment_count int NOT NULL CONSTRAINT DF_mail_send_log_attachments DEFAULT 0,
    sent_at datetime2(0) NOT NULL CONSTRAINT DF_mail_send_log_sent_at DEFAULT SYSUTCDATETIME()
);
GO

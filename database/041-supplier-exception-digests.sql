USE [optilens_local];
GO

IF OBJECT_ID(N'ops.DailyExceptionDigests', N'U') IS NULL
BEGIN
    CREATE TABLE ops.DailyExceptionDigests (
        digest_id uniqueidentifier NOT NULL CONSTRAINT DF_ops_daily_exception_digests_id DEFAULT NEWID(),
        digest_date date NOT NULL,
        recipient_reference nvarchar(300) NOT NULL,
        status nvarchar(30) NOT NULL CONSTRAINT DF_ops_daily_exception_digests_status DEFAULT N'PENDING',
        attempts int NOT NULL CONSTRAINT DF_ops_daily_exception_digests_attempts DEFAULT 0,
        last_error nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_ops_daily_exception_digests_created DEFAULT SYSUTCDATETIME(),
        sent_at datetime2(0) NULL,
        CONSTRAINT PK_ops_daily_exception_digests PRIMARY KEY (digest_id),
        CONSTRAINT UQ_ops_daily_exception_digests_date_recipient UNIQUE (digest_date, recipient_reference),
        CONSTRAINT CK_ops_daily_exception_digests_status CHECK (status IN (N'PENDING', N'SENT', N'FAILED'))
    );
END;
GO

/*
  Job Floor direct status update: one-time setup on the Innovations SQL Server.
  DRAFT FOR REVIEW. Nothing in this repository runs it. A SQL Server administrator
  runs it (SSMS or sqlcmd) after reading it.

  Creates:
    1. An Innovations application user "OPTILENS" that status history is attributed to.
    2. A SQL login + database user "optilens_jobfloor" with only the grants the
       writer in lib/job-floor-source.js needs.

  Does NOT put any password in Git. Set @Password below when you run it, then store
  the secret only in the OptiLens secure configuration (source-mssql write profile).
  See docs/JOB_FLOOR_STATUS_UPDATE.md.
*/

SET QUOTED_IDENTIFIER ON;   -- sqlcmd defaults this OFF (use sqlcmd -I); the UserAccounts insert needs it ON
SET XACT_ABORT ON;
GO

/* ---- Part A: the Innovations application user (run in the Innovations database) ---- */
USE Innovations;
GO

IF NOT EXISTS (SELECT 1 FROM dbo.UserAccounts WHERE UserName = 'OPTILENS')
BEGIN
  INSERT INTO dbo.UserAccounts (UserName, DisplayName, FirstName, LastName, JobTitle, Active, SecurityLevel, Flags, Authentication)
  VALUES ('OPTILENS', N'OptiLens Job Floor', N'OptiLens', N'Job Floor', N'Integration (service)', 1, 0, 0,
          -- Not a hash the Innovations login can ever match: this identity is for attribution only.
          'NO-LOGIN-SERVICE-ACCOUNT');
END;

-- Note the id; it is the value for the OptiLens setting job_floor.source_user_account_id.
SELECT UserAccountID, UserName, Active, SecurityLevel, JobTitle
FROM dbo.UserAccounts WHERE UserName = 'OPTILENS';
GO

/* ---- Part B: least-privilege writer ---- */
USE master;
GO

DECLARE @Password nvarchar(128) = N'<<SET A LONG RANDOM PASSWORD HERE>>';   -- do not commit a real value
IF @Password LIKE N'<<%' THROW 50000, 'Set @Password before running.', 1;

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'optilens_jobfloor')
BEGIN
  DECLARE @sql nvarchar(max) = N'CREATE LOGIN [optilens_jobfloor] WITH PASSWORD = N''' + REPLACE(@Password, '''', '''''')
    + N''', DEFAULT_DATABASE = [Innovations], CHECK_POLICY = ON, CHECK_EXPIRATION = OFF;';
  EXEC (@sql);
END;
GO

USE Innovations;
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'optilens_jobfloor')
  CREATE USER [optilens_jobfloor] FOR LOGIN [optilens_jobfloor];
GO

-- Reads needed to validate and plan an update.
GRANT SELECT ON OBJECT::dbo.Orders         TO [optilens_jobfloor];
GRANT SELECT ON OBJECT::dbo.OrderStatuses  TO [optilens_jobfloor];
GRANT SELECT ON OBJECT::dbo.StatusItems    TO [optilens_jobfloor];
GRANT SELECT ON OBJECT::dbo.GenStatus      TO [optilens_jobfloor];
GRANT SELECT ON OBJECT::dbo.UserAccounts   TO [optilens_jobfloor];

-- The three writes, column-limited where the statement only touches a few columns.
GRANT INSERT ON OBJECT::dbo.OrderStatuses TO [optilens_jobfloor];
GRANT UPDATE (EndDate, LastUpdated) ON OBJECT::dbo.OrderStatuses TO [optilens_jobfloor];
GRANT UPDATE (CurrentHistoryID, CurrentStatusID, CurrentStatusDate, NumberOfStatuses, UpdatedBy, LastUpdated)
  ON OBJECT::dbo.Orders TO [optilens_jobfloor];

-- LastUpdated is stamped with dbo.now(), exactly as the vendor application does.
GRANT EXECUTE ON OBJECT::dbo.now TO [optilens_jobfloor];
GO

/* ---- Verify (run as an administrator) ---- */
-- Effective permissions of the new user; expect only the grants above.
EXECUTE AS USER = N'optilens_jobfloor';
SELECT HAS_PERMS_BY_NAME(N'dbo.Orders', N'OBJECT', N'UPDATE')        AS orders_update,         -- 1
       HAS_PERMS_BY_NAME(N'dbo.Orders', N'OBJECT', N'INSERT')        AS orders_insert,         -- 0
       HAS_PERMS_BY_NAME(N'dbo.Orders', N'OBJECT', N'DELETE')        AS orders_delete,         -- 0
       HAS_PERMS_BY_NAME(N'dbo.OrderStatuses', N'OBJECT', N'INSERT') AS history_insert,        -- 1
       HAS_PERMS_BY_NAME(N'dbo.OrderStatuses', N'OBJECT', N'DELETE') AS history_delete,        -- 0
       HAS_PERMS_BY_NAME(N'dbo.Locks', N'OBJECT', N'SELECT')         AS locks_select,          -- 0
       HAS_PERMS_BY_NAME(N'dbo.TransactionIDs', N'OBJECT', N'UPDATE') AS transactionids_update; -- 0
REVERT;
GO

/* ---- Roll back (only if you need to remove it) ----
USE Innovations;
DROP USER IF EXISTS [optilens_jobfloor];
USE master;
DROP LOGIN [optilens_jobfloor];
-- The OPTILENS UserAccounts row is referenced by history it wrote; deactivate instead of deleting:
-- UPDATE Innovations.dbo.UserAccounts SET Active = 0 WHERE UserName = 'OPTILENS';
*/

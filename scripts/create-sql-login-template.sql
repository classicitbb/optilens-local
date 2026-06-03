/*
  Run this in SQL Server Management Studio as a SQL admin.
  Replace the password before running. Do not save the real password in the repository.
*/

USE [master];
GO

IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'optilens_app')
BEGIN
    CREATE LOGIN [optilens_app]
    WITH PASSWORD = N'REPLACE_WITH_STRONG_PASSWORD',
         CHECK_POLICY = ON,
         CHECK_EXPIRATION = OFF;
END;
GO

USE [optilens_local];
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'optilens_app')
BEGIN
    CREATE USER [optilens_app] FOR LOGIN [optilens_app];
END;
GO

ALTER ROLE [db_owner] ADD MEMBER [optilens_app];
GO

/*
  For the source Innovations database, grant read-only only.
  Run this only after confirming the login should be allowed to read source data.

USE [Innovations];
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'optilens_app')
BEGIN
    CREATE USER [optilens_app] FOR LOGIN [optilens_app];
END;
GO

ALTER ROLE [db_datareader] ADD MEMBER [optilens_app];
GO
*/

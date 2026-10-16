/*
  Creates the application's SQL login and gives it ownership of optilens_local only.
  Run by Install-OptiLens.ps1 through sqlcmd. The password arrives in the
  OPTILENS_APP_PASSWORD environment variable (sqlcmd expands $(NAME) from the
  environment), so it never appears on a command line or in this file.
*/
USE [master];
GO

IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'optilens_app')
BEGIN
    CREATE LOGIN [optilens_app]
    WITH PASSWORD = N'$(OPTILENS_APP_PASSWORD)',
         CHECK_POLICY = ON,
         CHECK_EXPIRATION = OFF;
END
ELSE
BEGIN
    ALTER LOGIN [optilens_app] WITH PASSWORD = N'$(OPTILENS_APP_PASSWORD)';
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

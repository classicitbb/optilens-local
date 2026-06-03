/*
  Run from master with a SQL login or Windows account that can create databases.
  Recommended database name uses underscore for script friendliness.
*/

IF DB_ID(N'optilens_local') IS NULL
BEGIN
    CREATE DATABASE [optilens_local];
END;
GO

ALTER DATABASE [optilens_local] SET RECOVERY SIMPLE;
GO

USE [optilens_local];
GO

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'core')
    EXEC(N'CREATE SCHEMA core');
GO

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'delivery')
    EXEC(N'CREATE SCHEMA delivery');
GO

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'integration')
    EXEC(N'CREATE SCHEMA integration');
GO

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'archive')
    EXEC(N'CREATE SCHEMA archive');
GO

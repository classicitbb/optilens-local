-- BeSwift commercial-invoice work defaults to the production portal.
--
-- 012 created both portal_environment columns with a N'training' default, from
-- when the integration was still being proven against the training portal. The
-- delivery-export form now submits an explicit environment on every save, so a
-- row that arrives without one comes from a caller that never chose, and those
-- belong on the portal the operators actually file against.
--
-- Existing rows keep whatever environment they were filed under; only the
-- default for new rows changes.

IF EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DF_delivery_co_applications_environment')
    ALTER TABLE delivery.co_applications DROP CONSTRAINT DF_delivery_co_applications_environment;
GO

IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DF_delivery_co_applications_environment')
    ALTER TABLE delivery.co_applications
        ADD CONSTRAINT DF_delivery_co_applications_environment DEFAULT N'production' FOR portal_environment;
GO

IF EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DF_delivery_co_automation_jobs_environment')
    ALTER TABLE delivery.co_automation_jobs DROP CONSTRAINT DF_delivery_co_automation_jobs_environment;
GO

IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = N'DF_delivery_co_automation_jobs_environment')
    ALTER TABLE delivery.co_automation_jobs
        ADD CONSTRAINT DF_delivery_co_automation_jobs_environment DEFAULT N'production' FOR portal_environment;
GO

USE [optilens_local];
GO

IF OBJECT_ID(N'core.tenants', N'U') IS NULL
BEGIN
    CREATE TABLE core.tenants (
        tenant_id uniqueidentifier NOT NULL CONSTRAINT DF_core_tenants_id DEFAULT NEWID(),
        tenant_code nvarchar(80) NOT NULL,
        tenant_name nvarchar(200) NOT NULL,
        is_active bit NOT NULL CONSTRAINT DF_core_tenants_active DEFAULT 1,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_core_tenants_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_core_tenants PRIMARY KEY (tenant_id),
        CONSTRAINT UQ_core_tenants_code UNIQUE (tenant_code)
    );
END;
GO

IF OBJECT_ID(N'core.modules', N'U') IS NULL
BEGIN
    CREATE TABLE core.modules (
        module_id uniqueidentifier NOT NULL CONSTRAINT DF_core_modules_id DEFAULT NEWID(),
        module_code nvarchar(100) NOT NULL,
        module_name nvarchar(200) NOT NULL,
        route_path nvarchar(300) NOT NULL,
        status nvarchar(40) NOT NULL,
        is_enabled bit NOT NULL CONSTRAINT DF_core_modules_enabled DEFAULT 1,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_core_modules_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_core_modules PRIMARY KEY (module_id),
        CONSTRAINT UQ_core_modules_code UNIQUE (module_code)
    );
END;
GO

IF OBJECT_ID(N'core.users', N'U') IS NULL
BEGIN
    CREATE TABLE core.users (
        user_id uniqueidentifier NOT NULL CONSTRAINT DF_core_users_id DEFAULT NEWID(),
        tenant_id uniqueidentifier NULL,
        username nvarchar(160) NOT NULL,
        display_name nvarchar(200) NOT NULL,
        email nvarchar(260) NULL,
        is_active bit NOT NULL CONSTRAINT DF_core_users_active DEFAULT 1,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_core_users_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_core_users PRIMARY KEY (user_id),
        CONSTRAINT UQ_core_users_username UNIQUE (username),
        CONSTRAINT FK_core_users_tenant FOREIGN KEY (tenant_id) REFERENCES core.tenants(tenant_id)
    );
END;
GO

IF OBJECT_ID(N'core.roles', N'U') IS NULL
BEGIN
    CREATE TABLE core.roles (
        role_id uniqueidentifier NOT NULL CONSTRAINT DF_core_roles_id DEFAULT NEWID(),
        role_code nvarchar(100) NOT NULL,
        role_name nvarchar(200) NOT NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_core_roles_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_core_roles PRIMARY KEY (role_id),
        CONSTRAINT UQ_core_roles_code UNIQUE (role_code)
    );
END;
GO

IF OBJECT_ID(N'core.permissions', N'U') IS NULL
BEGIN
    CREATE TABLE core.permissions (
        permission_id uniqueidentifier NOT NULL CONSTRAINT DF_core_permissions_id DEFAULT NEWID(),
        module_id uniqueidentifier NULL,
        permission_code nvarchar(160) NOT NULL,
        permission_name nvarchar(200) NOT NULL,
        CONSTRAINT PK_core_permissions PRIMARY KEY (permission_id),
        CONSTRAINT UQ_core_permissions_code UNIQUE (permission_code),
        CONSTRAINT FK_core_permissions_module FOREIGN KEY (module_id) REFERENCES core.modules(module_id)
    );
END;
GO

IF OBJECT_ID(N'core.user_roles', N'U') IS NULL
BEGIN
    CREATE TABLE core.user_roles (
        user_id uniqueidentifier NOT NULL,
        role_id uniqueidentifier NOT NULL,
        assigned_at datetime2(0) NOT NULL CONSTRAINT DF_core_user_roles_assigned DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_core_user_roles PRIMARY KEY (user_id, role_id),
        CONSTRAINT FK_core_user_roles_user FOREIGN KEY (user_id) REFERENCES core.users(user_id),
        CONSTRAINT FK_core_user_roles_role FOREIGN KEY (role_id) REFERENCES core.roles(role_id)
    );
END;
GO

IF OBJECT_ID(N'core.role_permissions', N'U') IS NULL
BEGIN
    CREATE TABLE core.role_permissions (
        role_id uniqueidentifier NOT NULL,
        permission_id uniqueidentifier NOT NULL,
        assigned_at datetime2(0) NOT NULL CONSTRAINT DF_core_role_permissions_assigned DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_core_role_permissions PRIMARY KEY (role_id, permission_id),
        CONSTRAINT FK_core_role_permissions_role FOREIGN KEY (role_id) REFERENCES core.roles(role_id),
        CONSTRAINT FK_core_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES core.permissions(permission_id)
    );
END;
GO

IF OBJECT_ID(N'core.audit_events', N'U') IS NULL
BEGIN
    CREATE TABLE core.audit_events (
        audit_event_id bigint IDENTITY(1,1) NOT NULL,
        tenant_id uniqueidentifier NULL,
        module_code nvarchar(100) NULL,
        actor_user_id uniqueidentifier NULL,
        event_type nvarchar(120) NOT NULL,
        entity_type nvarchar(160) NULL,
        entity_id nvarchar(160) NULL,
        event_data nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_core_audit_events_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_core_audit_events PRIMARY KEY (audit_event_id)
    );
END;
GO

IF OBJECT_ID(N'integration.connections', N'U') IS NULL
BEGIN
    CREATE TABLE integration.connections (
        connection_id uniqueidentifier NOT NULL CONSTRAINT DF_integration_connections_id DEFAULT NEWID(),
        connection_code nvarchar(120) NOT NULL,
        connection_name nvarchar(200) NOT NULL,
        connection_type nvarchar(80) NOT NULL,
        safe_config_json nvarchar(max) NULL,
        secret_reference nvarchar(300) NULL,
        mode nvarchar(40) NOT NULL CONSTRAINT DF_integration_connections_mode DEFAULT N'read-only',
        is_enabled bit NOT NULL CONSTRAINT DF_integration_connections_enabled DEFAULT 1,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_integration_connections_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_integration_connections PRIMARY KEY (connection_id),
        CONSTRAINT UQ_integration_connections_code UNIQUE (connection_code)
    );
END;
GO

IF OBJECT_ID(N'integration.runs', N'U') IS NULL
BEGIN
    CREATE TABLE integration.runs (
        integration_run_id bigint IDENTITY(1,1) NOT NULL,
        connection_id uniqueidentifier NULL,
        run_type nvarchar(120) NOT NULL,
        status nvarchar(40) NOT NULL,
        started_at datetime2(0) NOT NULL CONSTRAINT DF_integration_runs_started DEFAULT SYSUTCDATETIME(),
        finished_at datetime2(0) NULL,
        rows_seen int NULL,
        rows_written int NULL,
        message nvarchar(max) NULL,
        CONSTRAINT PK_integration_runs PRIMARY KEY (integration_run_id),
        CONSTRAINT FK_integration_runs_connection FOREIGN KEY (connection_id) REFERENCES integration.connections(connection_id)
    );
END;
GO

IF OBJECT_ID(N'core.llm_agents', N'U') IS NULL
BEGIN
    CREATE TABLE core.llm_agents (
        llm_agent_id uniqueidentifier NOT NULL CONSTRAINT DF_core_llm_agents_id DEFAULT NEWID(),
        agent_code nvarchar(120) NOT NULL,
        agent_name nvarchar(200) NOT NULL,
        endpoint_url nvarchar(500) NULL,
        is_enabled bit NOT NULL CONSTRAINT DF_core_llm_agents_enabled DEFAULT 0,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_core_llm_agents_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_core_llm_agents PRIMARY KEY (llm_agent_id),
        CONSTRAINT UQ_core_llm_agents_code UNIQUE (agent_code)
    );
END;
GO

IF OBJECT_ID(N'core.llm_activity_log', N'U') IS NULL
BEGIN
    CREATE TABLE core.llm_activity_log (
        llm_activity_id bigint IDENTITY(1,1) NOT NULL,
        llm_agent_id uniqueidentifier NULL,
        actor_user_id uniqueidentifier NULL,
        module_code nvarchar(100) NULL,
        action_name nvarchar(160) NOT NULL,
        request_summary nvarchar(max) NULL,
        response_summary nvarchar(max) NULL,
        created_at datetime2(0) NOT NULL CONSTRAINT DF_core_llm_activity_log_created DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_core_llm_activity_log PRIMARY KEY (llm_activity_id),
        CONSTRAINT FK_core_llm_activity_log_agent FOREIGN KEY (llm_agent_id) REFERENCES core.llm_agents(llm_agent_id)
    );
END;
GO

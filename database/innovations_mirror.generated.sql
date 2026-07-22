-- Generated innovations_mirror DDL from the Actian Zen catalog.

-- Review before applying. This script intentionally contains no source write-back.

IF SCHEMA_ID(N'sync') IS NULL EXEC('CREATE SCHEMA sync');

GO

IF OBJECT_ID(N'sync.SyncState', N'U') IS NULL
BEGIN
  CREATE TABLE sync.SyncState (
    table_name nvarchar(128) NOT NULL CONSTRAINT PK_sync_SyncState PRIMARY KEY,
    strategy nvarchar(20) NULL,
    watermark datetime2(3) NULL,
    last_run_at datetime2(0) NULL,
    last_full_at datetime2(0) NULL,
    last_rows int NULL,
    total_rows int NULL,
    last_error nvarchar(max) NULL
  );
END;

GO

IF OBJECT_ID(N'dbo.Customers', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[Customers] (
    [CustomerID] int NOT NULL,
    [BuyinGroupID] int NULL,
    [CardTypeID] int NULL,
    [ChainID] int NULL,
    [CreditIndicatorID] int NULL,
    [CurrencyID] int NULL,
    [EFTInstitutionID] int NULL,
    [GLAccountID] int NULL,
    [LanguageID] int NULL,
    [PayCycleID] int NULL,
    [PayingAgentID] int NULL,
    [PaymentTermsID] int NULL,
    [PriceListID] int NULL,
    [SalesRepID] int NULL,
    [ShippingMethodID] int NULL,
    [ShippingServerID] int NULL,
    [ShippingZoneID] int NULL,
    [SpecificEOMCodeID] int NULL,
    [TaxAuthorityID] int NULL,
    [AccountNumber] nvarchar(max) NULL,
    [AccountsEmailAddress] nvarchar(max) NULL,
    [AllowBackOrders] bit NULL,
    [AllowPartialShipping] bit NULL,
    [BalancingMethod] int NULL,
    [BillToID] int NULL,
    [CardExpiryMonth] smallint NULL,
    [CardExpiryYear] smallint NULL,
    [CardHolderName] nvarchar(max) NULL,
    [CardNumber] nvarchar(max) NULL,
    [CardSecurityCode] smallint NULL,
    [CommentID] int NULL,
    [CustomerName] nvarchar(max) NULL,
    [DateCreated] datetime2(3) NULL,
    [DefaultPaymentType] smallint NULL,
    [DetailedInvoice] bit NULL,
    [Discount] money NULL,
    [DiscountByValueID] int NULL,
    [DiscountPromptPayID] int NULL,
    [EFTAccount] nvarchar(max) NULL,
    [EFTReference] nvarchar(max) NULL,
    [EFTSortCode] nvarchar(max) NULL,
    [EmailDueReport] bit NULL,
    [EmailInvoice] bit NULL,
    [EmailOverdueReport] bit NULL,
    [EmailStatements] bit NULL,
    [ExportDeclaration] nvarchar(max) NULL,
    [FaxNumber] nvarchar(max) NULL,
    [FinanceCharge] bit NULL,
    [FixedCharge] bit NULL,
    [FixedShippingCharge] money NULL,
    [FreeShippingIn] bit NULL,
    [FreeShippingOut] bit NULL,
    [FreightCharge] money NULL,
    [FreightCode] nvarchar(max) NULL,
    [FreightPricelistID] int NULL,
    [GeneralEmailAddress] nvarchar(max) NULL,
    [GroupByPackingSlip] bit NULL,
    [HidePatientNameOnWIP] bit NULL,
    [InvoiceCycleID] int NULL,
    [InvoiceMethod] int NULL,
    [IsActive] bit NULL,
    [IsInternal] bit NULL,
    [IsLab] bit NULL,
    [IsPOMandatory] bit NULL,
    [LastCycleInvoiceDate] datetime2(3) NULL,
    [LastCycleRun] datetime2(3) NULL,
    [LinkedLab] int NULL,
    [ListID] nvarchar(max) NULL,
    [PatientMandatory] bit NULL,
    [PayByCard] bit NULL,
    [PayByEFT] bit NULL,
    [PhoneNumber] nvarchar(max) NULL,
    [POMandatory] bit NULL,
    [PriceOrders] bit NULL,
    [PrintByOriginator] bit NULL,
    [Pwd] nvarchar(max) NULL,
    [PwdRequired] bit NULL,
    [RxInvoicesToPrint] tinyint NULL,
    [SalesTaxAltCode] nvarchar(max) NULL,
    [SalesTaxPrimaryCode] nvarchar(max) NULL,
    [SendNotifications] bit NULL,
    [SendWIPEmail] bit NULL,
    [SendWIPFax] bit NULL,
    [SendWIPReport] bit NULL,
    [ShipToCustomer] bit NULL,
    [ShipToID] int NULL,
    [SpecialPriceListID] int NULL,
    [StatementCycle] int NULL,
    [StatementDiscount] money NULL,
    [StatementDiscountID] int NULL,
    [StockInvoicesToPrint] tinyint NULL,
    [StoreCode] nvarchar(max) NULL,
    [SuperInvoicing] bit NULL,
    [SuppressPricingOnDoc] bit NULL,
    [SuppressPricingOnInv] bit NULL,
    [TaxExempNumber] nvarchar(max) NULL,
    [TaxRegNumber] nvarchar(max) NULL,
    [UseInvoiceCycles] bit NULL,
    [UsePayingAgent] bit NULL,
    [VolumeDiscount] bit NULL,
    [VolumeDiscountID] int NULL,
    [WIPEmailAddress] nvarchar(max) NULL,
    [WIPFaxNumber] nvarchar(max) NULL,
    [WIPInternetAccess] bit NULL,
    [WIPReportEndTime] datetime2(3) NULL,
    [WIPReportStartTime] datetime2(3) NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    [DiscountEndDate] datetime2(3) NULL,
    [AddPricelistID] int NULL,
    [FinEdgedPricelistID] int NULL,
    [FinUncutPricelistID] int NULL,
    [FramePricelistID] int NULL,
    [MiscItemPricelistID] int NULL,
    [OSPricelistID] int NULL,
    [PackagePricelistID] int NULL,
    [PrismPricelistID] int NULL,
    [RxEdgedPricelistID] int NULL,
    [RxUncutPricelistID] int NULL,
    [StockLensPricelistID] int NULL,
    [ExcludeFromReports] bit NULL,
    [ExcludeZeroWIP] bit NULL,
    [ShipmentBin] nvarchar(max) NULL,
    [ShipmentSlipID] int NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([CustomerID])
  );
END;

GO

IF OBJECT_ID(N'dbo.UserAccounts', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[UserAccounts] (
    [UserAccountID] int NOT NULL,
    [Active] bit NULL,
    [Authentication] nvarchar(max) NULL,
    [EMailAddress] nvarchar(max) NULL,
    [ExtensionNumber] nvarchar(max) NULL,
    [FailedLogins] smallint NULL,
    [FirstName] nvarchar(max) NULL,
    [Flags] int NULL,
    [HomePhone] nvarchar(max) NULL,
    [JobTitle] nvarchar(max) NULL,
    [LastLogin] datetime2(3) NULL,
    [LastLoginMachine] nvarchar(max) NULL,
    [LastName] nvarchar(max) NULL,
    [LockUntilDate] datetime2(3) NULL,
    [MobileNumber] nvarchar(max) NULL,
    [SecurityLevel] int NULL,
    [UserName] nvarchar(max) NULL,
    [WarehouseID] int NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    [DisplayName] nvarchar(max) NULL,
    CONSTRAINT [PK_UserAccounts] PRIMARY KEY ([UserAccountID])
  );
END;

GO

IF OBJECT_ID(N'dbo.ShippingMethods', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[ShippingMethods] (
    [ShippingMethodID] int NOT NULL,
    [ChargeForLabel] bit NULL,
    [ChargeMiscItemID] int NULL,
    [ChargeMiscItemID2] int NULL,
    [ChargePercent] float NULL,
    [ChargePercent2] float NULL,
    [ChargeUsePricelist] bit NULL,
    [ChargeUsePriceList2] bit NULL,
    [Code] nvarchar(max) NULL,
    [Insure] bit NULL,
    [IsDefault] bit NULL,
    [ListID] nvarchar(max) NULL,
    [ShippingCarrierID] int NULL,
    [ShippingMethodName] nvarchar(max) NULL,
    [ShippingServiceID] int NULL,
    [TrackingURL] nvarchar(max) NULL,
    [UseEasyPost] bit NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    [IsActive] bit NULL,
    [ChargeHandlingFee] bit NULL,
    [PromptForTrackingNum] bit NULL,
    [ShipReferenceID] int NULL,
    [PrintStockOrders] bit NULL,
    [UseShipmentPrinter] bit NULL,
    CONSTRAINT [PK_ShippingMethods] PRIMARY KEY ([ShippingMethodID])
  );
END;

GO

IF OBJECT_ID(N'dbo.EFTInstitutions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[EFTInstitutions] (
    [EFTInstitutionID] int NOT NULL,
    [AccountMask] nvarchar(max) NULL,
    [EFTInstitutionName] nvarchar(max) NULL,
    [SortCodeMask] nvarchar(max) NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    CONSTRAINT [PK_EFTInstitutions] PRIMARY KEY ([EFTInstitutionID])
  );
END;

GO

IF OBJECT_ID(N'dbo.Contacts', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[Contacts] (
    [ContactID] int NOT NULL,
    [CustomerID] int NULL,
    [TitleID] int NULL,
    [EmailAddress] nvarchar(max) NULL,
    [ExtensionNumber] nvarchar(max) NULL,
    [FaxNumber] nvarchar(max) NULL,
    [FirstName] nvarchar(max) NULL,
    [JobDescription] nvarchar(max) NULL,
    [ListID] nvarchar(max) NULL,
    [MobileNumber] nvarchar(max) NULL,
    [PhoneNumber] nvarchar(max) NULL,
    [PrimaryContact] bit NULL,
    [Surname] nvarchar(max) NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    CONSTRAINT [PK_Contacts] PRIMARY KEY ([ContactID])
  );
END;

GO

IF OBJECT_ID(N'dbo.CustomerAddresses', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[CustomerAddresses] (
    [CustomerAddressID] int NOT NULL,
    [CountryID] int NULL,
    [CountyID] int NULL,
    [CustomerID] int NULL,
    [RegionID] int NULL,
    [AddressType] int NULL,
    [ExternalID] nvarchar(max) NULL,
    [Line1] nvarchar(max) NULL,
    [Line2] nvarchar(max) NULL,
    [Line3] nvarchar(max) NULL,
    [Locality] nvarchar(max) NULL,
    [PostCode] nvarchar(max) NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    CONSTRAINT [PK_CustomerAddresses] PRIMARY KEY ([CustomerAddressID])
  );
END;

GO

IF OBJECT_ID(N'dbo.Countries', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[Countries] (
    [CountryID] int NOT NULL,
    [CountryName] nvarchar(max) NULL,
    [CustomsInfoRequired] bit NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    [ShippingMethodID] int NULL,
    CONSTRAINT [PK_Countries] PRIMARY KEY ([CountryID])
  );
END;

GO

IF OBJECT_ID(N'dbo.BuyinGroups', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[BuyinGroups] (
    [BuyinGroupID] int NOT NULL,
    [BuyinGroupName] nvarchar(max) NULL,
    [Code] nvarchar(max) NULL,
    [ProcessType] nvarchar(max) NULL,
    [ProgramName] nvarchar(max) NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    CONSTRAINT [PK_BuyinGroups] PRIMARY KEY ([BuyinGroupID])
  );
END;

GO

IF OBJECT_ID(N'dbo.OrderTypes', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[OrderTypes] (
    [OrderTypeID] int NOT NULL,
    [OrderType] bigint NULL,
    [OrderTypeName] nvarchar(max) NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    [Credit] bit NULL,
    [OrderSign] smallint NULL,
    CONSTRAINT [PK_OrderTypes] PRIMARY KEY ([OrderTypeID])
  );
END;

GO

IF OBJECT_ID(N'dbo.GenStatus', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[GenStatus] (
    [GenStatusID] int NOT NULL,
    [GenStatus] bigint NULL,
    [Active] bit NULL,
    [Cancelled] bit NULL,
    [GenStatusName] nvarchar(max) NULL,
    [Outsourced] bit NULL,
    [Queued] bit NULL,
    [Shipped] bit NULL,
    [Waiting] bit NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    CONSTRAINT [PK_GenStatus] PRIMARY KEY ([GenStatusID])
  );
END;

GO

IF OBJECT_ID(N'dbo.StatusItems', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[StatusItems] (
    [StatusItemID] int NOT NULL,
    [FutureBreakageID] int NULL,
    [MiscItemID] int NULL,
    [NotificationID] int NULL,
    [POReturnReasonID] int NULL,
    [PrintOnStatusID] int NULL,
    [StatusItemGroupID] int NULL,
    [UserAccountID] int NULL,
    [UserGroupID] int NULL,
    [Cancellation] bit NULL,
    [CheckHoldConditions] bit NULL,
    [Cost] money NULL,
    [DebitFrame] bit NULL,
    [DebitLens] bit NULL,
    [DebitMisc] bit NULL,
    [DiscountType] smallint NULL,
    [DiscountValue] money NULL,
    [ExcludeFromTAT] bit NULL,
    [Flags] decimal(20,0) NULL,
    [HighlightColor] int NULL,
    [Inactive] tinyint NULL,
    [LDSCode] smallint NULL,
    [MaxBreakages] int NULL,
    [Originating] bit NULL,
    [OverrideRejectMins] bit NULL,
    [Priority] smallint NULL,
    [ReceiveFarmout] bit NULL,
    [RejectMins] int NULL,
    [ShowInAssignments] bit NULL,
    [ShowInMobileApp] bit NULL,
    [ShowInOrderEntry] bit NULL,
    [ShowInQuickUpdate] bit NULL,
    [ShowInTracking] bit NULL,
    [ShowInTrayChange] bit NULL,
    [ShowInUpdateDialog] bit NULL,
    [StatusItemName] nvarchar(max) NULL,
    [StatusItemType] smallint NULL,
    [StockFlags] int NULL,
    [Terminating] bit NULL,
    [Unship] bit NULL,
    [UseFarmoutLabStatus] bit NULL,
    [VerifyFrame] bit NULL,
    [VerifyLens] bit NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    CONSTRAINT [PK_StatusItems] PRIMARY KEY ([StatusItemID])
  );
END;

GO

IF OBJECT_ID(N'dbo.Translations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[Translations] (
    [TranslationID] int NOT NULL,
    [ItemID] int NULL,
    [LocaleID] int NULL,
    [TypeID] int NULL,
    [TranslationText] nvarchar(max) NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    CONSTRAINT [PK_Translations] PRIMARY KEY ([TranslationID])
  );
END;

GO

IF OBJECT_ID(N'dbo.Locales', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[Locales] (
    [LocaleID] int NOT NULL,
    [WinLocaleID] int NULL,
    [Active] bit NULL,
    [LocaleGroupID] int NULL,
    [Name] nvarchar(max) NULL,
    [Priority] int NULL,
    [ShortName] nvarchar(max) NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    CONSTRAINT [PK_Locales] PRIMARY KEY ([LocaleID])
  );
END;

GO

IF OBJECT_ID(N'dbo.CustomerBalances', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[CustomerBalances] (
    [CustomerBalanceID] int NOT NULL,
    [CustomerID] int NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    [CreditLimit] money NULL,
    [CreditsPTD] money NULL,
    [CreditsYTD] money NULL,
    [CreditWaitingTotal] money NULL,
    [CurrentBalance] money NULL,
    [CurrentWIPValue] money NULL,
    [DiscountValuePTD] money NULL,
    [DiscountValueYTD] money NULL,
    [FinanceChargesPTD] money NULL,
    [FinanceChargesYTD] money NULL,
    [LastPaymentAmount] money NULL,
    [LastPaymentDate] datetime2(3) NULL,
    [LastStatementAmount] money NULL,
    [LastStatementDate] datetime2(3) NULL,
    [LastWIPReport] datetime2(3) NULL,
    [PaymentsPTD] money NULL,
    [PaymentsYTD] money NULL,
    [SalesCostPTD] money NULL,
    [SalesCostYTD] money NULL,
    [SalesValuePTD] money NULL,
    [SalesValueYTD] money NULL,
    [SalesVolumePTD] money NULL,
    [SalesVolumeYTD] money NULL,
    [WIPLimit] money NULL,
    CONSTRAINT [PK_CustomerBalances] PRIMARY KEY ([CustomerBalanceID])
  );
END;

GO

IF OBJECT_ID(N'dbo.StockLots', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[StockLots] (
    [StockLotID] int NOT NULL,
    [BinID] int NULL,
    [POReceiptID] int NULL,
    [StockLocationID] int NULL,
    [Active] tinyint NULL,
    [Cost] money NULL,
    [LotNumber] nvarchar(max) NULL,
    [OnHand] int NULL,
    [ReceivedDate] datetime2(3) NULL,
    [ReceivedQty] int NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    CONSTRAINT [PK_StockLots] PRIMARY KEY ([StockLotID])
  );
END;

GO

IF OBJECT_ID(N'dbo.FinAROpenItems', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[FinAROpenItems] (
    [FinAROpenItemID] int NOT NULL,
    [CustomerID] int NULL,
    [FinARAgingPeriodID] int NULL,
    [FinARBillingRunID] int NULL,
    [FinARPeriodID] int NULL,
    [FinARStatementID] int NULL,
    [FinARStatementRunID] int NULL,
    [InvoiceID] int NULL,
    [OrderID] bigint NULL,
    [Allowance] money NULL,
    [AmountDue] money NULL,
    [CreditAmount] money NULL,
    [Discount] money NULL,
    [FinARAgingPeriodNum] tinyint NULL,
    [FinARStatus] tinyint NULL,
    [HideFromStatement] bit NULL,
    [InvoiceTime] datetime2(3) NULL,
    [InvoiceType] int NULL,
    [Iteration] int NULL,
    [LastPaymentDate] datetime2(3) NULL,
    [NumCredits] int NULL,
    [NumPayments] int NULL,
    [OrderType] int NULL,
    [Patient] nvarchar(max) NULL,
    [PaymentAmount] money NULL,
    [PoNumber] nvarchar(max) NULL,
    [ReceivedTime] datetime2(3) NULL,
    [RxNumber] nvarchar(max) NULL,
    [ShipTime] datetime2(3) NULL,
    [SubTotal] money NULL,
    [TaxAmount] money NULL,
    [Total] money NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    CONSTRAINT [PK_FinAROpenItems] PRIMARY KEY ([FinAROpenItemID])
  );
END;

GO

IF OBJECT_ID(N'dbo.FinARAgingPeriods', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[FinARAgingPeriods] (
    [FinARAgingPeriodID] int NOT NULL,
    [ActualDays1] int NULL,
    [ActualDays2] int NULL,
    [ActualDays3] int NULL,
    [ActualDays4] int NULL,
    [AgingDays1] int NULL,
    [AgingDays2] int NULL,
    [AgingDays3] int NULL,
    [AgingDays4] int NULL,
    [AgingDesc1] nvarchar(max) NULL,
    [AgingDesc2] nvarchar(max) NULL,
    [AgingDesc3] nvarchar(max) NULL,
    [AgingDesc4] nvarchar(max) NULL,
    [ChargesOnCharges] bit NULL,
    [CycleEnd] int NULL,
    [CyleEndDate] datetime2(3) NULL,
    [FinanceCharge1] money NULL,
    [FinanceCharge2] money NULL,
    [FinanceCharge3] money NULL,
    [FinanceCharge4] money NULL,
    [Frequency] int NULL,
    [MaxCharge1] money NULL,
    [MaxCharge2] money NULL,
    [MaxCharge3] money NULL,
    [MaxCharge4] money NULL,
    [MinCharge1] money NULL,
    [MinCharge2] money NULL,
    [MinCharge3] money NULL,
    [MinCharge4] money NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    [AgePast120] bit NULL,
    [PeriodStatus] tinyint NULL,
    CONSTRAINT [PK_FinARAgingPeriods] PRIMARY KEY ([FinARAgingPeriodID])
  );
END;

GO

IF OBJECT_ID(N'dbo.FinARPeriods', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[FinARPeriods] (
    [FinARPeriodID] int NOT NULL,
    [FinMonth] int NULL,
    [FinYear] int NULL,
    [NumWorkingDays] int NULL,
    [PeriodEnd] datetime2(3) NULL,
    [PeriodStart] datetime2(3) NULL,
    [PeriodStatus] tinyint NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    CONSTRAINT [PK_FinARPeriods] PRIMARY KEY ([FinARPeriodID])
  );
END;

GO

IF OBJECT_ID(N'dbo.Shipments', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[Shipments] (
    [ShipmentID] int NOT NULL,
    [PMTransactionID] int NULL,
    [ShippingMethodID] int NULL,
    [CarrierName] nvarchar(max) NULL,
    [Delivered] tinyint NULL,
    [ExternalBatchID] nvarchar(max) NULL,
    [ExternalRateID] nvarchar(max) NULL,
    [ExternalShipmentID] nvarchar(max) NULL,
    [ExternalTrackID] nvarchar(max) NULL,
    [LabelCost] float NULL,
    [LabelPath] nvarchar(max) NULL,
    [LabelURL] nvarchar(max) NULL,
    [PickupID] int NULL,
    [ServiceName] nvarchar(max) NULL,
    [TrackingNumber] nvarchar(max) NULL,
    [TrackingURL] nvarchar(max) NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    [ShipmentTypeID] int NULL,
    [ShipToID] int NULL,
    [ErrorType] tinyint NULL,
    [RecordDeleted] tinyint NULL,
    [ResultMessage] nvarchar(max) NULL,
    [Shipped] tinyint NULL,
    [ShippedTime] datetime2(3) NULL,
    [ShipmentBatchID] int NULL,
    [Reference] nvarchar(max) NULL,
    [CurrentTrackerID] int NULL,
    CONSTRAINT [PK_Shipments] PRIMARY KEY ([ShipmentID])
  );
END;

GO

IF OBJECT_ID(N'dbo.ShipmentItems', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[ShipmentItems] (
    [ShipmentItemID] int NOT NULL,
    [ShipmentID] int NULL,
    [OrderID] decimal(20,0) NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    [ShipmentChargeID] int NULL,
    CONSTRAINT [PK_ShipmentItems] PRIMARY KEY ([ShipmentItemID])
  );
END;

GO

IF OBJECT_ID(N'dbo.Orders', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[Orders] (
    [OrderID] int NOT NULL,
    [BillToID] int NULL,
    [CurrentHistoryID] int NULL,
    [CustomerID] int NULL,
    [EntityID] int NULL,
    [OriginalOrderID] int NULL,
    [PHIDetailID] int NULL,
    [RemakeOfOrderID] int NULL,
    [ShipToID] int NULL,
    [WorkplaceID] int NULL,
    [JobID] nvarchar(max) NULL,
    [JobIDLeft] nvarchar(max) NULL,
    [JobIDRight] nvarchar(max) NULL,
    [BillToReference] nvarchar(max) NULL,
    [CriticalStatusID] int NULL,
    [CriticalStatusDate] datetime2(3) NULL,
    [CurrencyID] int NULL,
    [CurrentStatusID] int NULL,
    [CurrentStatusDate] datetime2(3) NULL,
    [CustomerAccount] nvarchar(max) NULL,
    [CustomerOperator] nvarchar(max) NULL,
    [CustomerOrdReference] nvarchar(max) NULL,
    [CustomerPOReference] nvarchar(max) NULL,
    [CustomerTime] datetime2(3) NULL,
    [CustomerTrayID] nvarchar(max) NULL,
    [ElapsedTime] float NULL,
    [EntryOperator] nvarchar(max) NULL,
    [Format] int NULL,
    [GenStatus] bigint NULL,
    [GroupOrderCode] nvarchar(max) NULL,
    [GroupOrderIteration] int NULL,
    [LastResult] int NULL,
    [LastResultMessage] nvarchar(max) NULL,
    [NumberOfStatuses] bigint NULL,
    [OrderFlags0] int NULL,
    [OrderFlags1] int NULL,
    [OrderFlags2] int NULL,
    [OrderFlags3] int NULL,
    [OrderFlags4] int NULL,
    [OrderFlags5] int NULL,
    [OrderFlags6] int NULL,
    [OrderFlags7] int NULL,
    [OrderType] bigint NULL,
    [PatientID] nvarchar(max) NULL,
    [PlanID] nvarchar(max) NULL,
    [Priority] bigint NULL,
    [PromisedTime] datetime2(3) NULL,
    [ReceivedTime] datetime2(3) NULL,
    [ShipMethodID] nvarchar(max) NULL,
    [ShipMethodReference] nvarchar(max) NULL,
    [ShippedTime] datetime2(3) NULL,
    [ShipToReference] nvarchar(max) NULL,
    [Source] int NULL,
    [StatusFlags0] int NULL,
    [StatusFlags1] int NULL,
    [StatusFlags2] int NULL,
    [StatusFlags3] int NULL,
    [StatusFlags4] int NULL,
    [StatusFlags5] int NULL,
    [StatusFlags6] int NULL,
    [StatusFlags7] int NULL,
    [WaitStatus0] int NULL,
    [WaitStatus1] int NULL,
    [WaitStatus2] int NULL,
    [WaitStatus3] int NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([OrderID])
  );
END;

GO

IF OBJECT_ID(N'dbo.RxArchive', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[RxArchive] (
    [Traynum] nvarchar(max) NULL,
    [JobGroup] smallint NULL,
    [JobCode] smallint NULL,
    [Account] nvarchar(max) NULL,
    [RxNum] nvarchar(max) NULL,
    [Iteration] smallint NULL,
    [SerialNum] int NULL,
    [RxDate] date NULL,
    [RxTime] time(0) NULL,
    [ShipByDate] date NULL,
    [ShipByTime] time(0) NULL,
    [ShipDate] date NULL,
    [ShipTime] time(0) NULL,
    [Patient] nvarchar(max) NULL,
    [OperatorID] nvarchar(max) NULL,
    [EmployeeID] nvarchar(max) NULL,
    [Provider] nvarchar(max) NULL,
    [OrderType] smallint NULL,
    [AccountNum] int NULL,
    [PtNum] int NULL,
    [PrvNum] int NULL,
    [TotalCharge] float NULL,
    [DepositOrLens] float NULL,
    [BalanceOrFrame] float NULL,
    [TotalLens] float NULL,
    [TotalFrame] float NULL,
    [TotalCost] float NULL,
    [FrameCost] float NULL,
    [OtherCost] float NULL,
    [LensCost] float NULL,
    [EdgeCharge] float NULL,
    [ExtrasCharge] float NULL,
    [RxDBL11] float NULL,
    [RxDBL12] float NULL,
    [RFFLensMG] int NULL,
    [RFFLensMT] int NULL,
    [RFFLensMF] int NULL,
    [RFFLensLT] int NULL,
    [RFFLensLO] int NULL,
    [RFFLensLI] int NULL,
    [LFFLensMG] int NULL,
    [LFFLensMT] int NULL,
    [LFFLensMF] int NULL,
    [LFFLensLT] int NULL,
    [LFFLensLO] int NULL,
    [LFFLensLI] int NULL,
    [TermCode] smallint NULL,
    [RemakeIteration] smallint NULL,
    [CritStat] smallint NULL,
    [JType] smallint NULL,
    [BatchResult] smallint NULL,
    [NumRights] smallint NULL,
    [NumLefts] smallint NULL,
    [NumFrames] smallint NULL,
    [EdgeMode] smallint NULL,
    [RxINT9] smallint NULL,
    [RxINT10] smallint NULL,
    [RMTOCode] smallint NULL,
    [LMTOCode] smallint NULL,
    [IDFlags] smallint NULL,
    [RIDEyeFlags] smallint NULL,
    [LIDEyeFlags] smallint NULL,
    [RLensItem] int NULL,
    [RLensOption] int NULL,
    [RLensType] int NULL,
    [RLensMF] int NULL,
    [RLensMatl] int NULL,
    [RLensMG] int NULL,
    [LLensItem] int NULL,
    [LLensOption] int NULL,
    [LLensType] int NULL,
    [LLensMF] int NULL,
    [LLensMatl] int NULL,
    [LLensMG] int NULL,
    [RSettings] smallint NULL,
    [LSettings] smallint NULL,
    [RBlkMode] smallint NULL,
    [LBlkMode] smallint NULL,
    [RSVGrindMode] smallint NULL,
    [LSVGrindMode] smallint NULL,
    [RSphere] float NULL,
    [LSphere] float NULL,
    [RCyl] float NULL,
    [LCyl] float NULL,
    [RAxis] float NULL,
    [LAxis] float NULL,
    [RFarPD] float NULL,
    [LFarPD] float NULL,
    [RDec] float NULL,
    [LDec] float NULL,
    [RNearPD] float NULL,
    [LNearPD] float NULL,
    [RInset] float NULL,
    [LInset] float NULL,
    [RTotalDec] float NULL,
    [LTotalDec] float NULL,
    [RSegHeight] float NULL,
    [LSegHeight] float NULL,
    [RDrop] float NULL,
    [LDrop] float NULL,
    [RSegDrop] float NULL,
    [LSegDrop] float NULL,
    [RVertDec] float NULL,
    [LVertDec] float NULL,
    [ROCHeight] float NULL,
    [LOCHeight] float NULL,
    [RAdd] float NULL,
    [LAdd] float NULL,
    [RPrismIn] float NULL,
    [LPrismIn] float NULL,
    [RPrismUp] float NULL,
    [LPrismUp] float NULL,
    [RPrismDiop] float NULL,
    [LPrismDiop] float NULL,
    [RPrismBase] float NULL,
    [LPrismBase] float NULL,
    [RPrismMMin] float NULL,
    [LPrismMMin] float NULL,
    [RPrismMMup] float NULL,
    [LPrismMMup] float NULL,
    [RNearSphere] float NULL,
    [LNearSphere] float NULL,
    [RNearCyl] float NULL,
    [LNearCyl] float NULL,
    [ROrigPrism] float NULL,
    [LOrigPrism] float NULL,
    [ROrigPrismBase] float NULL,
    [LOrigPrismBase] float NULL,
    [RCenterThk] float NULL,
    [LCenterThk] float NULL,
    [RMinCtrThk] float NULL,
    [LMinCtrThk] float NULL,
    [RMinEdgThk] float NULL,
    [LMinEdgThk] float NULL,
    [RMinAvgThk] float NULL,
    [LMinAvgThk] float NULL,
    [RRxHole] float NULL,
    [LRxHole] float NULL,
    [RRxCrib] float NULL,
    [LRxCrib] float NULL,
    [RPlusCylSph] float NULL,
    [LPlusCylSph] float NULL,
    [RPlusCylCyl] float NULL,
    [LPlusCylCyl] float NULL,
    [RPlusCylAxis] float NULL,
    [LPlusCylAxis] float NULL,
    [ROldVertex] float NULL,
    [LOldVertex] float NULL,
    [RNewVertex] float NULL,
    [LNewVertex] float NULL,
    [ROrigSphere] float NULL,
    [LOrigSphere] float NULL,
    [ROrigCyl] float NULL,
    [LOrigCyl] float NULL,
    [ROrigAxis] float NULL,
    [LOrigAxis] float NULL,
    [RMinFinished] float NULL,
    [LMinFinished] float NULL,
    [RMinSemi] float NULL,
    [LMinSemi] float NULL,
    [RRecBase] float NULL,
    [LRecBase] float NULL,
    [RSelBase] float NULL,
    [LSelBase] float NULL,
    [RMagnify] float NULL,
    [LMagnify] float NULL,
    [RSlabOff] float NULL,
    [LSlabOff] float NULL,
    [ROrigAdd] float NULL,
    [LOrigAdd] float NULL,
    [ROrigFar] float NULL,
    [LOrigFar] float NULL,
    [ROrigNear] float NULL,
    [LOrigNear] float NULL,
    [ROrigLRP] float NULL,
    [LOrigLRP] float NULL,
    [ROrigPRP] float NULL,
    [LOrigPRP] float NULL,
    [RDatumHt] float NULL,
    [LDatumHt] float NULL,
    [RPanto] float NULL,
    [LPanto] float NULL,
    [RFreeform] float NULL,
    [LFreeform] float NULL,
    [RAdd1] float NULL,
    [LAdd1] float NULL,
    [RAdd2] float NULL,
    [LAdd2] float NULL,
    [RBlkInset] float NULL,
    [LBlkInset] float NULL,
    [RBlkDrop] float NULL,
    [LBlkDrop] float NULL,
    [RBlkSize] float NULL,
    [LBlkSize] float NULL,
    [RBlkCtr] float NULL,
    [LBlkCtr] float NULL,
    [RBlkEdg] float NULL,
    [LBlkEdg] float NULL,
    [RBlkFront] float NULL,
    [LBlkFront] float NULL,
    [RFill1] float NULL,
    [LFill1] float NULL,
    [RThinPrism] float NULL,
    [LThinPrism] float NULL,
    [RNearAxis] float NULL,
    [LNearAxis] float NULL,
    [RIndex] float NULL,
    [LIndex] float NULL,
    [Temple] smallint NULL,
    [Bridge] smallint NULL,
    [Eye] smallint NULL,
    [Color] smallint NULL,
    [FrameItem] smallint NULL,
    [ManufacturerNumber] smallint NULL,
    [FrameItemNumber] smallint NULL,
    [SKU] nvarchar(max) NULL,
    [BillCode] nvarchar(max) NULL,
    [Bin] nvarchar(max) NULL,
    [Pattern] nvarchar(max) NULL,
    [Source] smallint NULL,
    [UserType] smallint NULL,
    [FrameType] smallint NULL,
    [TempleNumber] smallint NULL,
    [MessageNumber] smallint NULL,
    [flags] smallint NULL,
    [RightA] int NULL,
    [RightB] int NULL,
    [RightED] int NULL,
    [RightAX] int NULL,
    [RightCirc] int NULL,
    [RightFill] int NULL,
    [LeftA] int NULL,
    [LeftB] int NULL,
    [LeftED] int NULL,
    [LeftAX] int NULL,
    [LeftCirc] int NULL,
    [LeftFill] int NULL,
    [FlagTwo] int NULL,
    [Turnover] int NULL,
    [PeriodLength] int NULL,
    [LeadTime] int NULL,
    [Fill5] int NULL,
    [DBL] int NULL,
    [Edger] smallint NULL,
    [MaxBase] smallint NULL,
    [MinBase] smallint NULL,
    [XtraChart] int NULL,
    [MaxThkNasal] int NULL,
    [MaxThkTemporal] int NULL,
    [MaxThkTop] int NULL,
    [MaxThkBottom] int NULL,
    [Fill10] int NULL,
    [DropBCUnder] smallint NULL,
    [Price1] float NULL,
    [Cost] float NULL,
    [CreateDate] float NULL,
    [UpdateDate] float NULL,
    [OnHand] smallint NULL,
    [OnOrder] smallint NULL,
    [ToBeOrdered] smallint NULL,
    [OnBackOrder] smallint NULL,
    [OrderAtQty] smallint NULL,
    [MinimumOrder] smallint NULL,
    [UsedToday] smallint NULL,
    [UsedWeek] smallint NULL,
    [UsedMonth] smallint NULL,
    [UsedLastMonth] smallint NULL,
    [UseTwoMonthsAgo] smallint NULL,
    [UsedThisYear] smallint NULL,
    [SPOOnOrder] smallint NULL,
    [SPOOnBackOrder] smallint NULL,
    [BOUntilDate] int NULL,
    [ActiveDate] int NULL,
    [RRxFlag] smallint NULL,
    [LRxFlag] smallint NULL,
    [Compflag] smallint NULL,
    [Ordflag] smallint NULL,
    [NewStringRec] int NULL,
    [Warehouse] nvarchar(max) NULL,
    [FrameName] nvarchar(max) NULL,
    [LensAlias] nvarchar(max) NULL,
    [SpareString] nvarchar(max) NULL
  );
END;

GO

IF OBJECT_ID(N'dbo.Invoices', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[Invoices] (
    [InvoiceID] int NOT NULL,
    [ConsolInvoiceID] int NULL,
    [CustomerID] int NULL,
    [FinARAgingPeriodID] int NULL,
    [FinARBillingRunID] int NULL,
    [OrderID] bigint NULL,
    [AllowUnship] bit NULL,
    [ARPostStatus] tinyint NULL,
    [ARPostStatusType] tinyint NULL,
    [ARShipStatus] tinyint NULL,
    [ARShipStatusType] tinyint NULL,
    [Discount] money NULL,
    [FinARStatus] tinyint NULL,
    [InvoiceTime] datetime2(3) NULL,
    [InvoiceType] int NULL,
    [Iteration] int NULL,
    [ListID] nvarchar(max) NULL,
    [NoCharge] bit NULL,
    [PricingErrors] smallint NULL,
    [Printed] bit NULL,
    [PrintedTime] datetime2(3) NULL,
    [PrintError] bit NULL,
    [PrintErrorMsg] nvarchar(max) NULL,
    [QBPostStatus] tinyint NULL,
    [QBPostStatusType] tinyint NULL,
    [QBTxnID] nvarchar(max) NULL,
    [RecordCreated] datetime2(3) NULL,
    [ReferenceInvoiceID] int NULL,
    [Status] smallint NULL,
    [SubTotal] money NULL,
    [TaxAmount] money NULL,
    [Total] money NULL,
    [TransactionID] decimal(20,0) NULL,
    [UseFinishedLensPrice] tinyint NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [LastUpdated] datetime2(3) NULL,
    [ReasonID] int NULL,
    [Billable] tinyint NULL,
    CONSTRAINT [PK_Invoices] PRIMARY KEY ([InvoiceID])
  );
END;

GO

IF OBJECT_ID(N'dbo.InvoiceLines', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[InvoiceLines] (
    [InvoiceLineID] int NOT NULL,
    [CreditActionID] int NULL,
    [CreditDeniedID] int NULL,
    [CreditReasonID] int NULL,
    [InvoiceID] int NULL,
    [PriceListID] int NULL,
    [ReferenceLineID] int NULL,
    [Appoved] bit NULL,
    [Audit] nvarchar(max) NULL,
    [CalculatedQty] money NULL,
    [CategoryType] smallint NULL,
    [Chirality] smallint NULL,
    [ComponentPrice] money NULL,
    [CostGLAccountID] int NULL,
    [CostPrice] money NULL,
    [Description] nvarchar(max) NULL,
    [GLAccountID] int NULL,
    [GLAccountNumber] nvarchar(max) NULL,
    [Inv_Debited] money NULL,
    [Inv_OnHand] money NULL,
    [Inv_ReturnToInv] money NULL,
    [Inv_Shipped] money NULL,
    [Inv_SPOrder] money NULL,
    [Inv_ToOrder] money NULL,
    [InvGLAccountID] int NULL,
    [InvoiceLineType] int NULL,
    [InvoicePrice] money NULL,
    [ItemType] int NULL,
    [LineNumber] int NULL,
    [PackageID] int NULL,
    [PrePackagePrice] money NULL,
    [PriceGroupID] int NULL,
    [PriceListName] nvarchar(max) NULL,
    [PriceListPrice] money NULL,
    [PriceListType] tinyint NULL,
    [QBTxnLineID] nvarchar(max) NULL,
    [Quantity] float NULL,
    [Reason] nvarchar(max) NULL,
    [RecordID] nvarchar(max) NULL,
    [ReferenceOrderID] decimal(20,0) NULL,
    [SKU] nvarchar(max) NULL,
    [TotalTaxAmount] money NULL,
    [TotalTaxPercent] money NULL,
    [UserName] nvarchar(max) NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    [Suppressed] bit NULL,
    CONSTRAINT [PK_InvoiceLines] PRIMARY KEY ([InvoiceLineID])
  );
END;

GO

IF OBJECT_ID(N'dbo.FinARSalesJournal', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[FinARSalesJournal] (
    [FinARSalesJournalID] int NOT NULL,
    [CustomerID] int NULL,
    [FinARAgingPeriodID] int NULL,
    [FinARBillingRunID] int NULL,
    [FinARPeriodID] int NULL,
    [FinARStatementID] int NULL,
    [InvoiceID] int NULL,
    [OrderID] bigint NULL,
    [Allowance] money NULL,
    [AmountDue] money NULL,
    [CreditAmount] money NULL,
    [Discount] money NULL,
    [FinARAgingPeriodNum] tinyint NULL,
    [FinARStatus] tinyint NULL,
    [HideFromStatement] bit NULL,
    [InvoiceTime] datetime2(3) NULL,
    [InvoiceType] int NULL,
    [Iteration] int NULL,
    [LastPaymentDate] datetime2(3) NULL,
    [NumCredits] int NULL,
    [NumPayments] int NULL,
    [OrderType] int NULL,
    [Patient] nvarchar(max) NULL,
    [PaymentAmount] money NULL,
    [PoNumber] nvarchar(max) NULL,
    [ReceivedTime] datetime2(3) NULL,
    [RxNumber] nvarchar(max) NULL,
    [ShipTime] datetime2(3) NULL,
    [Status] smallint NULL,
    [SubTotal] money NULL,
    [TaxAmount] money NULL,
    [Total] money NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    [Reversal] tinyint NULL,
    CONSTRAINT [PK_FinARSalesJournal] PRIMARY KEY ([FinARSalesJournalID])
  );
END;

GO

IF OBJECT_ID(N'dbo.FinARStatements', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[FinARStatements] (
    [FinARStatementID] int NOT NULL,
    [CustomerID] int NULL,
    [FinARPeriodID] int NULL,
    [FinARStatementRunID] int NULL,
    [AgingAmount1] money NULL,
    [AgingAmount2] money NULL,
    [AgingAmount3] money NULL,
    [AgingAmount4] money NULL,
    [Allowance] money NULL,
    [CalcDiscountWithTax] bit NULL,
    [ClosingBalance] money NULL,
    [CommentID] int NULL,
    [CustomerDefault] bit NULL,
    [Discount] money NULL,
    [DueDate] datetime2(3) NULL,
    [EligibleDiscount] money NULL,
    [EMailed] bit NULL,
    [FinanceCharges] money NULL,
    [FromDate] datetime2(3) NULL,
    [OpeningBalance] money NULL,
    [Payments] money NULL,
    [Printed] bit NULL,
    [SalesNet] money NULL,
    [SalesNetTax] money NULL,
    [SalesRegular] money NULL,
    [SalesRegularTax] money NULL,
    [SalesSuperNet] money NULL,
    [SalesSuperNetTax] money NULL,
    [StatementDate] datetime2(3) NULL,
    [Status] tinyint NULL,
    [TaxAmount] money NULL,
    [ToDate] datetime2(3) NULL,
    [Transactions] money NULL,
    [Void] bit NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    [InvoiceDiscounts] money NULL,
    CONSTRAINT [PK_FinARStatements] PRIMARY KEY ([FinARStatementID])
  );
END;

GO

IF OBJECT_ID(N'dbo.FinARStatementItems', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.[FinARStatementItems] (
    [FinARStatementItemID] int NOT NULL,
    [FinARPaymentID] int NULL,
    [FinARSalesJournalID] int NULL,
    [FinARStatementID] int NULL,
    [FinARStatementRunID] int NULL,
    [LinkTypeID] int NULL,
    [Amount] money NULL,
    [HideFromStatement] bit NULL,
    [InvoiceID] int NULL,
    [LinkType] int NULL,
    [OrderID] decimal(20,0) NULL,
    [OrderType] tinyint NULL,
    [Patient] nvarchar(max) NULL,
    [PaymentMethod] tinyint NULL,
    [PostDate] datetime2(3) NULL,
    [Reference] nvarchar(max) NULL,
    [TransDate] datetime2(3) NULL,
    [CreatedBy] int NULL,
    [UpdatedBy] int NULL,
    [RecordCreated] datetime2(3) NULL,
    [LastUpdated] datetime2(3) NULL,
    [AmountDue] money NULL,
    CONSTRAINT [PK_FinARStatementItems] PRIMARY KEY ([FinARStatementItemID])
  );
END;

GO

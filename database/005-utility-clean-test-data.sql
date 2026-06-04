USE [optilens_local];
GO

DELETE e
FROM delivery.shipment_events e
INNER JOIN delivery.shipment_sessions s
    ON s.shipment_session_id = e.shipment_session_id
WHERE s.source_shipment_id LIKE N'TEST-%'
   OR s.customer_account LIKE N'TEST-%';
GO

DELETE FROM delivery.shipment_sessions
WHERE source_shipment_id LIKE N'TEST-%'
   OR customer_account LIKE N'TEST-%';
GO

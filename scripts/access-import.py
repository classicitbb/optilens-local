import argparse
import json
import os
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import pyodbc


DEFAULT_SOURCE = r"C:\Users\cvre\OneDrive\OPTICINFO\CV Accounts BE DB\CV_Accounts_be.accdb"
DEFAULT_OUTPUT = "docs/access-import-last-run.json"


def main():
    parser = argparse.ArgumentParser(description="Import Access delivery history into OptiLens Local archive tables.")
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="Path to CV_Accounts_be.accdb")
    parser.add_argument("--months", type=int, default=6, help="Number of months of delivery history to import")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="JSON summary output path")
    args = parser.parse_args()

    source = Path(args.source)
    if not source.exists():
        raise SystemExit(f"Access source not found: {source}")

    cutoff = subtract_months(date.today(), args.months)
    batch_id = str(uuid4())
    summary = {
        "import_batch_id": batch_id,
        "source": str(source),
        "history_months": args.months,
        "cutoff_date": cutoff.isoformat(),
        "started_at": datetime.now(timezone.utc).isoformat(),
        "mode": "read Access, write optilens_local archive",
        "tables": {},
    }

    access = connect_access(source)
    sql = connect_sql_server()

    try:
        sql.autocommit = False
        create_batch(sql, batch_id, source, cutoff, args.months)

        delivery_ids = import_deliveries(access, sql, batch_id, cutoff)
        summary["tables"]["archive.access_deliveries"] = len(delivery_ids)
        summary["tables"]["archive.access_delivery_items"] = import_delivery_items(access, sql, batch_id, cutoff)
        summary["tables"]["archive.access_delivery_extras"] = import_delivery_extras(access, sql, batch_id, cutoff)
        summary["tables"]["archive.access_commercial_invoices"] = import_commercial_invoices(access, sql, batch_id, cutoff)
        summary["tables"]["archive.access_customer_branches"] = import_customer_branches(access, sql, batch_id)
        summary["tables"]["archive.access_couriers"] = import_couriers(access, sql, batch_id)
        summary["tables"]["archive.access_ci_declarations"] = import_ci_declarations(access, sql, batch_id)
        summary["tables"]["archive.access_ci_goods"] = import_ci_goods(access, sql, batch_id)
        summary["tables"]["archive.access_dispatchers"] = import_dispatchers(access, sql, batch_id)
        summary["tables"]["archive.access_company"] = import_company(access, sql, batch_id)

        summary["delivery_no_min"] = min(delivery_ids) if delivery_ids else None
        summary["delivery_no_max"] = max(delivery_ids) if delivery_ids else None
        summary["completed_at"] = datetime.now(timezone.utc).isoformat()
        complete_batch(sql, batch_id, "completed", summary)
        sql.commit()
    except Exception as error:
        sql.rollback()
        try:
            fail_sql = connect_sql_server()
            complete_batch(fail_sql, batch_id, "failed", {**summary, "error": str(error)})
            fail_sql.commit()
            fail_sql.close()
        except Exception:
            pass
        raise
    finally:
        access.close()
        sql.close()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, indent=2, default=json_default), encoding="utf-8")
    print(json.dumps(summary, indent=2, default=json_default))


def connect_access(source):
    conn_str = (
        "DRIVER={Microsoft Access Driver (*.mdb, *.accdb)};"
        f"DBQ={source};"
        "ExtendedAnsiSQL=1;"
        "READONLY=TRUE;"
    )
    return pyodbc.connect(conn_str, autocommit=True)


def connect_sql_server():
    config = app_db_config()
    conn_str = (
        "DRIVER={ODBC Driver 17 for SQL Server};"
        f"SERVER={config['server']};"
        f"DATABASE={config['database']};"
        f"UID={config['user']};"
        f"PWD={config['password']};"
        f"Encrypt={'yes' if config['encrypt'] else 'no'};"
        f"TrustServerCertificate={'yes' if config['trustServerCertificate'] else 'no'};"
    )
    return pyodbc.connect(conn_str)


def app_db_config():
    base = {
        "server": os.environ.get("OPTILENS_DB_SERVER", "MSSQL-SVR"),
        "database": os.environ.get("OPTILENS_DB_NAME", "optilens_local"),
        "user": os.environ.get("OPTILENS_DB_USER", ""),
        "password": os.environ.get("OPTILENS_DB_PASSWORD", ""),
        "encrypt": parse_bool(os.environ.get("OPTILENS_DB_ENCRYPT"), True),
        "trustServerCertificate": parse_bool(os.environ.get("OPTILENS_DB_TRUST_CERT"), True),
    }

    vault_path = Path(__file__).resolve().parents[1] / "data" / "vault.json"
    try:
        vault = json.loads(vault_path.read_text(encoding="utf-8"))
        entries = vault.get("data", {}).get("SQL Server", [])
        entry = next(
            (
                item for item in entries
                if "app db" in item.get("name", "").lower()
                or "optilens_local" in item.get("name", "").lower()
            ),
            None,
        )
        if entry:
            fields = {
                normalize_field(field.get("label")): field.get("val")
                for field in entry.get("fields", [])
            }
            if fields.get("password"):
                base.update({
                    "server": fields.get("server") or fields.get("host") or base["server"],
                    "database": fields.get("database") or base["database"],
                    "user": fields.get("username") or fields.get("user") or base["user"],
                    "password": fields.get("password") or base["password"],
                    "encrypt": parse_bool(fields.get("encrypt"), base["encrypt"]),
                    "trustServerCertificate": parse_bool(
                        fields.get("trustcert") or fields.get("trustservercertificate"),
                        base["trustServerCertificate"],
                    ),
                })
    except Exception:
        pass

    if not base["user"] or not base["password"]:
        raise SystemExit("App DB credentials are not configured in environment or shared vault.")

    return base


def parse_bool(value, fallback):
    if value in (None, ""):
        return fallback
    return str(value).lower() in {"1", "true", "yes", "on"}


def normalize_field(value):
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def create_batch(conn, batch_id, source, cutoff, months):
    execute(
        conn,
        """
        INSERT INTO archive.access_import_batches (
            import_batch_id, source_path, cutoff_date, history_months
        )
        VALUES (?, ?, ?, ?)
        """,
        batch_id,
        str(source),
        cutoff,
        months,
    )


def complete_batch(conn, batch_id, status, summary):
    execute(
        conn,
        """
        UPDATE archive.access_import_batches
        SET completed_at = SYSUTCDATETIME(),
            status = ?,
            summary_json = ?
        WHERE import_batch_id = ?
        """,
        status,
        json.dumps(summary, default=json_default),
        batch_id,
    )


def import_deliveries(access, sql, batch_id, cutoff):
    rows = fetch_dicts(
        access,
        """
        SELECT [DeliveryNo], [DeliveryDate], [Dispatcher], [Courier]
        FROM [Deliveries]
        WHERE [DeliveryDate] >= ?
        """,
        cutoff,
    )

    for row in rows:
        execute(
            sql,
            """
            MERGE archive.access_deliveries AS target
            USING (SELECT ? AS legacy_delivery_no) AS source
              ON target.legacy_delivery_no = source.legacy_delivery_no
            WHEN MATCHED THEN
              UPDATE SET delivery_date = ?, dispatcher_legacy_id = ?, courier_legacy_id = ?,
                         import_batch_id = ?, imported_at = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN
              INSERT (legacy_delivery_no, delivery_date, dispatcher_legacy_id, courier_legacy_id, import_batch_id)
              VALUES (?, ?, ?, ?, ?);
            """,
            row["DeliveryNo"],
            row["DeliveryDate"],
            row["Dispatcher"],
            row["Courier"],
            batch_id,
            row["DeliveryNo"],
            row["DeliveryDate"],
            row["Dispatcher"],
            row["Courier"],
            batch_id,
        )

    return [int(row["DeliveryNo"]) for row in rows]


def import_delivery_items(access, sql, batch_id, cutoff):
    rows = fetch_dicts(
        access,
        """
        SELECT i.[ID], i.[DeliveryNo], i.[RxInvoiceNo], i.[Comments], i.[CustomerBranchID],
               i.[Patient], i.[Total], i.[CustomerID], i.[Description], i.[CustomerPO], i.[RxNumber]
        FROM [DeliveryItems] AS i
        INNER JOIN [Deliveries] AS d ON i.[DeliveryNo] = d.[DeliveryNo]
        WHERE d.[DeliveryDate] >= ?
        """,
        cutoff,
    )

    for row in rows:
        execute(
            sql,
            """
            MERGE archive.access_delivery_items AS target
            USING (SELECT ? AS legacy_item_id) AS source
              ON target.legacy_item_id = source.legacy_item_id
            WHEN MATCHED THEN
              UPDATE SET legacy_delivery_no = ?, rx_invoice_no = ?, comments = ?,
                         customer_branch_legacy_id = ?, patient = ?, total = ?, customer_id = ?,
                         description = ?, customer_po = ?, rx_number = ?,
                         import_batch_id = ?, imported_at = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN
              INSERT (legacy_item_id, legacy_delivery_no, rx_invoice_no, comments,
                      customer_branch_legacy_id, patient, total, customer_id,
                      description, customer_po, rx_number, import_batch_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """,
            row["ID"], row["DeliveryNo"], row["RxInvoiceNo"], row["Comments"],
            row["CustomerBranchID"], row["Patient"], row["Total"], row["CustomerID"],
            row["Description"], row["CustomerPO"], row["RxNumber"], batch_id,
            row["ID"], row["DeliveryNo"], row["RxInvoiceNo"], row["Comments"],
            row["CustomerBranchID"], row["Patient"], row["Total"], row["CustomerID"],
            row["Description"], row["CustomerPO"], row["RxNumber"], batch_id,
        )

    return len(rows)


def import_delivery_extras(access, sql, batch_id, cutoff):
    rows = fetch_dicts(
        access,
        """
        SELECT e.[ID], e.[DeliveryNo], e.[CustomerBranchID], e.[CollectCheque], e.[Comments], e.[CustomerID]
        FROM [DeliveryExtras] AS e
        INNER JOIN [Deliveries] AS d ON e.[DeliveryNo] = d.[DeliveryNo]
        WHERE d.[DeliveryDate] >= ?
        """,
        cutoff,
    )

    for row in rows:
        execute(
            sql,
            """
            MERGE archive.access_delivery_extras AS target
            USING (SELECT ? AS legacy_extra_id) AS source
              ON target.legacy_extra_id = source.legacy_extra_id
            WHEN MATCHED THEN
              UPDATE SET legacy_delivery_no = ?, customer_branch_legacy_id = ?, collect_cheque = ?,
                         comments = ?, customer_id = ?, import_batch_id = ?, imported_at = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN
              INSERT (legacy_extra_id, legacy_delivery_no, customer_branch_legacy_id,
                      collect_cheque, comments, customer_id, import_batch_id)
              VALUES (?, ?, ?, ?, ?, ?, ?);
            """,
            row["ID"], row["DeliveryNo"], row["CustomerBranchID"], row["CollectCheque"],
            row["Comments"], row["CustomerID"], batch_id,
            row["ID"], row["DeliveryNo"], row["CustomerBranchID"], row["CollectCheque"],
            row["Comments"], row["CustomerID"], batch_id,
        )

    return len(rows)


def import_commercial_invoices(access, sql, batch_id, cutoff):
    rows = fetch_dicts(
        access,
        """
        SELECT ci.[INVID], ci.[DeliveryID], ci.[Carrier], ci.[Air waybill#], ci.[NoOfBoxes],
               ci.[GrossWeight], ci.[Cubic Mtrs], ci.[Declaration], ci.[DescriptionOfGoods],
               ci.[Packing], ci.[Freight], ci.[OtherCost], ci.[Insurance], ci.[PONumbers]
        FROM [Commercial Invoice] AS ci
        INNER JOIN [Deliveries] AS d ON ci.[DeliveryID] = d.[DeliveryNo]
        WHERE d.[DeliveryDate] >= ?
        """,
        cutoff,
    )

    for row in rows:
        execute(
            sql,
            """
            MERGE archive.access_commercial_invoices AS target
            USING (SELECT ? AS legacy_invoice_id) AS source
              ON target.legacy_invoice_id = source.legacy_invoice_id
            WHEN MATCHED THEN
              UPDATE SET legacy_delivery_no = ?, carrier = ?, airway_bill = ?, number_of_boxes = ?,
                         gross_weight = ?, cubic_meters = ?, declaration_text = ?,
                         description_of_goods = ?, packing_cost = ?, freight_cost = ?,
                         other_cost = ?, insurance_cost = ?, po_numbers = ?,
                         import_batch_id = ?, imported_at = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN
              INSERT (legacy_invoice_id, legacy_delivery_no, carrier, airway_bill, number_of_boxes,
                      gross_weight, cubic_meters, declaration_text, description_of_goods,
                      packing_cost, freight_cost, other_cost, insurance_cost, po_numbers, import_batch_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """,
            row["INVID"], row["DeliveryID"], row["Carrier"], row["Air waybill#"], row["NoOfBoxes"],
            row["GrossWeight"], row["Cubic Mtrs"], row["Declaration"], row["DescriptionOfGoods"],
            row["Packing"], row["Freight"], row["OtherCost"], row["Insurance"], row["PONumbers"], batch_id,
            row["INVID"], row["DeliveryID"], row["Carrier"], row["Air waybill#"], row["NoOfBoxes"],
            row["GrossWeight"], row["Cubic Mtrs"], row["Declaration"], row["DescriptionOfGoods"],
            row["Packing"], row["Freight"], row["OtherCost"], row["Insurance"], row["PONumbers"], batch_id,
        )

    return len(rows)


def import_customer_branches(access, sql, batch_id):
    rows = fetch_dicts(access, "SELECT * FROM [Customer Branches]")

    for row in rows:
        execute(
            sql,
            """
            MERGE archive.access_customer_branches AS target
            USING (SELECT ? AS legacy_branch_id) AS source
              ON target.legacy_branch_id = source.legacy_branch_id
            WHEN MATCHED THEN
              UPDATE SET customer_id = ?, account_number = ?, credit_limit = ?, opening_balance = ?,
                         location = ?, contact_name = ?, branch_name = ?, branch_tel = ?, branch_fax = ?,
                         category = ?, show_in_phone_list = ?, show_price_in_delivery = ?,
                         show_in_delivery_summary = ?, mobile_no = ?, overseas = ?, terms_of_payment = ?,
                         country = ?, not_in_delivery_list = ?, alias = ?, customer_category = ?,
                         import_batch_id = ?, imported_at = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN
              INSERT (legacy_branch_id, customer_id, account_number, credit_limit, opening_balance,
                      location, contact_name, branch_name, branch_tel, branch_fax, category,
                      show_in_phone_list, show_price_in_delivery, show_in_delivery_summary,
                      mobile_no, overseas, terms_of_payment, country, not_in_delivery_list,
                      alias, customer_category, import_batch_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """,
            row["ID"], row["Customer ID"], row["Account #"], row["Credit Limit"], row["Opening Balance"],
            row["Location"], row["Contact Name"], row["BranchName"], row["Branch Tel"], row["Branch Fax"],
            row["Category"], row["ShowInPhoneList"], row["ShowPriceInDelivery"], row["ShowInDeliverySummary"],
            row["Mobile No"], row["Overseas"], row["Terms Of Payment"], row["Country"],
            row["NotInDeliveryList"], row["Alias"], row["CustomerCategory"], batch_id,
            row["ID"], row["Customer ID"], row["Account #"], row["Credit Limit"], row["Opening Balance"],
            row["Location"], row["Contact Name"], row["BranchName"], row["Branch Tel"], row["Branch Fax"],
            row["Category"], row["ShowInPhoneList"], row["ShowPriceInDelivery"], row["ShowInDeliverySummary"],
            row["Mobile No"], row["Overseas"], row["Terms Of Payment"], row["Country"],
            row["NotInDeliveryList"], row["Alias"], row["CustomerCategory"], batch_id,
        )
        execute(
            sql,
            """
            MERGE delivery.customer_branches AS target
            USING (SELECT ? AS legacy_branch_id) AS source
              ON target.legacy_branch_id = source.legacy_branch_id
            WHEN MATCHED THEN
              UPDATE SET customer_account = ?, branch_name = ?, customer_id = ?,
                         show_price_in_delivery = ?, raw_json = ?
            WHEN NOT MATCHED THEN
              INSERT (legacy_branch_id, customer_account, branch_name, customer_id, show_price_in_delivery, raw_json)
              VALUES (?, ?, ?, ?, ?, ?);
            """,
            row["ID"], row["Account #"], row["BranchName"], stringify(row["Customer ID"]),
            row["ShowPriceInDelivery"], json.dumps(clean_row(row), default=json_default),
            row["ID"], row["Account #"], row["BranchName"], stringify(row["Customer ID"]),
            row["ShowPriceInDelivery"], json.dumps(clean_row(row), default=json_default),
        )

    return len(rows)


def import_couriers(access, sql, batch_id):
    rows = fetch_dicts(access, "SELECT [CourierID], [CourierName], [OverseaCourier] FROM [Couriers]")
    for row in rows:
        merge_simple(
            sql,
            "archive.access_couriers",
            "legacy_courier_id",
            ["courier_name", "overseas_courier", "import_batch_id"],
            [row["CourierID"], row["CourierName"], row["OverseaCourier"], batch_id],
        )
    return len(rows)


def import_ci_declarations(access, sql, batch_id):
    rows = fetch_dicts(access, "SELECT [ID], [Declarations] FROM [CIDeclarations]")
    for row in rows:
        merge_simple(
            sql,
            "archive.access_ci_declarations",
            "legacy_declaration_id",
            ["declaration_text", "import_batch_id"],
            [row["ID"], row["Declarations"], batch_id],
        )
    return len(rows)


def import_ci_goods(access, sql, batch_id):
    rows = fetch_dicts(access, "SELECT [ID], [DescriptionOfGoods] FROM [CIDescripOfGoods]")
    for row in rows:
        merge_simple(
            sql,
            "archive.access_ci_goods",
            "legacy_goods_id",
            ["description_of_goods", "import_batch_id"],
            [row["ID"], row["DescriptionOfGoods"], batch_id],
        )
    return len(rows)


def import_dispatchers(access, sql, batch_id):
    rows = fetch_dicts(access, "SELECT [DispatcherID], [DispatcherName] FROM [Dispatchers]")
    for row in rows:
        merge_simple(
            sql,
            "archive.access_dispatchers",
            "legacy_dispatcher_id",
            ["dispatcher_name", "import_batch_id"],
            [row["DispatcherID"], row["DispatcherName"], batch_id],
        )
        execute(
            sql,
            """
            MERGE delivery.dispatchers AS target
            USING (SELECT ? AS legacy_dispatcher_id) AS source
              ON target.legacy_dispatcher_id = source.legacy_dispatcher_id
            WHEN MATCHED THEN
              UPDATE SET dispatcher_name = ?
            WHEN NOT MATCHED THEN
              INSERT (legacy_dispatcher_id, dispatcher_name)
              VALUES (?, ?);
            """,
            row["DispatcherID"], row["DispatcherName"],
            row["DispatcherID"], row["DispatcherName"],
        )
    return len(rows)


def import_company(access, sql, batch_id):
    rows = fetch_dicts(access, "SELECT [ID], [CompanyName], [NoChargeAmount] FROM [Company]")
    for row in rows:
        merge_simple(
            sql,
            "archive.access_company",
            "legacy_company_id",
            ["company_name", "no_charge_amount", "import_batch_id"],
            [row["ID"], row["CompanyName"], row["NoChargeAmount"], batch_id],
        )
    return len(rows)


def merge_simple(conn, table, key_column, update_columns, values):
    key_value = values[0]
    update_values = values[1:]
    set_clause = ", ".join(f"{column} = ?" for column in update_columns)
    insert_columns = ", ".join([key_column, *update_columns])
    insert_placeholders = ", ".join("?" for _ in [key_column, *update_columns])
    sql = f"""
        MERGE {table} AS target
        USING (SELECT ? AS {key_column}) AS source
          ON target.{key_column} = source.{key_column}
        WHEN MATCHED THEN
          UPDATE SET {set_clause}, imported_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT ({insert_columns})
          VALUES ({insert_placeholders});
    """
    execute(conn, sql, key_value, *update_values, key_value, *update_values)


def fetch_dicts(conn, sql, *params):
    cursor = conn.cursor()
    cursor.execute(sql, params)
    columns = [column[0] for column in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def execute(conn, sql, *params):
    conn.cursor().execute(sql, tuple(normalize_value(value) for value in params))


def normalize_value(value):
    if isinstance(value, bool):
        return int(value)
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, datetime):
        return value.replace(microsecond=0)
    return value


def clean_row(row):
    return {key: normalize_json_value(value) for key, value in row.items()}


def normalize_json_value(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


def json_default(value):
    return normalize_json_value(value)


def stringify(value):
    if value is None:
        return None
    return str(value)


def subtract_months(value, months):
    month = value.month - months
    year = value.year
    while month <= 0:
        month += 12
        year -= 1

    day = min(value.day, days_in_month(year, month))
    return date(year, month, day)


def days_in_month(year, month):
    if month == 12:
        next_month = date(year + 1, 1, 1)
    else:
        next_month = date(year, month + 1, 1)
    return (next_month - date(year, month, 1)).days


if __name__ == "__main__":
    main()

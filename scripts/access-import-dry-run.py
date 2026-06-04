import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import pyodbc


DEFAULT_TABLES = [
    "Deliveries",
    "DeliveryItems",
    "DeliveryExtras",
    "Commercial Invoice",
    "Customer Branches",
    "Couriers",
    "CIDeclarations",
    "CIDescripOfGoods",
    "Dispatchers",
    "Company",
    "WhiteBoard",
]


def connect(access_path: Path):
    conn_str = (
        "DRIVER={Microsoft Access Driver (*.mdb, *.accdb)};"
        f"DBQ={access_path};"
        "ExtendedAnsiSQL=1;"
    )
    return pyodbc.connect(conn_str, autocommit=True)


def quote_name(name: str) -> str:
    return "[" + name.replace("]", "]]") + "]"


def count_rows(cursor, table: str) -> int:
    cursor.execute(f"SELECT COUNT(*) FROM {quote_name(table)}")
    return int(cursor.fetchone()[0])


def sample_columns(cursor, table: str):
    return [
        {
            "name": row.column_name,
            "type": row.type_name,
            "nullable": bool(row.nullable),
        }
        for row in cursor.columns(table=table)
    ]


def main():
    parser = argparse.ArgumentParser(description="Read-only Access import dry run for OptiLens Local.")
    parser.add_argument("--source", required=True, help="Path to CV_Accounts_be.accdb")
    parser.add_argument("--output", default="docs/access-import-dry-run.json", help="Output JSON path")
    args = parser.parse_args()

    source = Path(args.source)
    output = Path(args.output)

    if not source.exists():
        raise SystemExit(f"Access source not found: {source}")

    result = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": str(source),
        "mode": "read-only dry run",
        "retention_rule": "last 12 months active by ship date; older records routed to archive path",
        "tables": [],
        "notes": [
            "This dry run does not write to Access or MSSQL.",
            "Operational retention filters require ship-date mapping before import execution.",
            "Lookup/reference tables should be imported in full unless business owner says otherwise.",
        ],
    }

    with connect(source) as conn:
        cursor = conn.cursor()
        existing_tables = {row.table_name for row in cursor.tables(tableType="TABLE")}

        for table in DEFAULT_TABLES:
            entry = {
                "table": table,
                "exists": table in existing_tables,
                "row_count": None,
                "columns": [],
                "migration_treatment": treatment_for(table),
            }

            if entry["exists"]:
                entry["row_count"] = count_rows(cursor, table)
                entry["columns"] = sample_columns(cursor, table)

            result["tables"].append(entry)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"Wrote {output}")


def treatment_for(table: str) -> str:
    if table in {"Couriers", "CIDeclarations", "CIDescripOfGoods", "Dispatchers", "Company", "Customer Branches"}:
        return "reference/import-full"
    if table in {"Deliveries", "DeliveryItems", "DeliveryExtras", "Commercial Invoice"}:
        return "operational/import-last-12-months-plus-archive"
    return "review-before-import"


if __name__ == "__main__":
    main()

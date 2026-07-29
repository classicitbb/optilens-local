const { PDFParse } = require("pdf-parse");

const REPORT_HEADINGS = ["All Shipped Jobs", "Charges by Account and Job", "SkyLab Optical Laboratory"];
const DATE_RE = /\d{1,2}\/\d{1,2}\/\d{2,4}/g;
const DATE_CELL_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const ROW_RE = /^(\d{4,8})\s+\$?([\d,]+\.\d{2})(\d{4,8})\s+/;

function normalizeSpace(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

function parseSkyLabRow(line, page = 1) {
  const rawRow = String(line || "").trim();
  const tabCells = rawRow.split(/\t+/).map((cell) => normalizeSpace(cell));
  if (
    tabCells.length >= 7 &&
    /^\d{4,8}$/.test(tabCells[0]) &&
    /^\$?[\d,]+\.\d{2}$/.test(tabCells[1]) &&
    /^\d{4,8}$/.test(tabCells[2]) &&
    DATE_CELL_RE.test(tabCells[3].split(" ")[0]) &&
    DATE_CELL_RE.test(tabCells[4].split(" ")[0]) &&
    /^(Rx|Stock)$/i.test(tabCells[tabCells.length - 1])
  ) {
    const invType = tabCells[tabCells.length - 1].toUpperCase();
    const hasPatient = tabCells.length >= 8;
    const invoiceNumber = tabCells[tabCells.length - 2];
    const patientEnd = hasPatient ? tabCells.length - 2 : 5;
    return {
      orderNumber: tabCells[0],
      rxNumber: tabCells[2],
      charges: Number(tabCells[1].replace(/[,$]/g, "")),
      entryDate: tabCells[3].match(DATE_RE)[0],
      shippedDate: tabCells[4].match(DATE_RE)[0],
      patient: hasPatient ? normalizeSpace(tabCells.slice(5, patientEnd).join(" ")) : "",
      invoiceNumber,
      invType,
      sourcePage: page,
      sourceRowText: normalizeSpace(rawRow),
      ignored: invType !== "RX",
      warning: null
    };
  }

  const row = normalizeSpace(rawRow);
  const match = ROW_RE.exec(row);
  if (!match) return null;
  const afterReference = row.slice(match[0].length - 1);
  const dates = [...afterReference.matchAll(DATE_RE)];
  if (dates.length < 2) return { warning: "Could not identify entry and shipped dates", sourceRowText: row, page };
  const secondDate = dates[1];
  const afterDates = afterReference.slice(secondDate.index + secondDate[0].length);
  const tail = /(\d{4,10})\s+(Rx|Stock)\s*$/i.exec(afterDates);
  if (!tail) return { warning: "Could not identify invoice and inventory type", sourceRowText: row, page };
  const patient = normalizeSpace(afterDates.slice(0, tail.index));
  const invType = tail[2].toUpperCase();
  return {
    orderNumber: match[1],
    rxNumber: match[3],
    charges: Number(match[2].replace(/,/g, "")),
    entryDate: dates[0][0],
    shippedDate: dates[1][0],
    patient,
    invoiceNumber: tail[1],
    invType,
    sourcePage: page,
    sourceRowText: row,
    ignored: invType !== "RX",
    warning: null
  };
}

function parseSkyLabText(text, sourceName = "attachment.pdf") {
  const sourceText = String(text || "");
  const reportDetected = REPORT_HEADINGS.filter((heading) => sourceText.toLowerCase().includes(heading.toLowerCase())).length >= 2;
  if (!reportDetected) throw new Error("SkyLab shipped report headings were not detected.");
  const rows = sourceText.split(/\r?\n/).map((line) => parseSkyLabRow(line)).filter(Boolean);
  const parsedRows = rows.filter((row) => row.rxNumber);
  const items = parsedRows.filter((row) => !row.ignored).map((row) => ({
    supplierReference: row.rxNumber,
    originalSupplierReference: row.rxNumber,
    supplierStatus: "Shipped",
    rxNumber: row.rxNumber,
    patient: row.patient,
    invoiceNumber: row.invoiceNumber,
    entryDate: row.entryDate,
    shippedDate: row.shippedDate,
    charges: row.charges,
    invType: row.invType,
    sourcePage: row.sourcePage,
    sourceRowText: row.sourceRowText,
    extractionMethod: "PDF_TEXT"
  }));
  return {
    parser: "SkyLabShippedPdfParser",
    sourceName,
    extractionMethod: "PDF_TEXT",
    reportDetected,
    rows: parsedRows,
    items,
    ignoredRows: parsedRows.filter((row) => row.ignored),
    warnings: parsedRows.filter((row) => row.warning).map((row) => row.warning)
  };
}

async function parseSkyLabPdf(buffer, sourceName = "attachment.pdf") {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const parsed = parseSkyLabText(result.text, sourceName);
    if (!parsed.rows.length) throw new Error("SkyLab PDF contains no parseable shipped-job rows.");
    return parsed;
  } finally {
    await parser.destroy();
  }
}

module.exports = { parseSkyLabPdf, parseSkyLabRow, parseSkyLabText, REPORT_HEADINGS };

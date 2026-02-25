/**
 * content-csv.js — CSV generation and download for SF Query Editor Helper.
 *
 * Loaded before content.js in the MAIN "world" (same JS execution context).
 * Exposes window.__SF_DC_CSV__ with helpers used by both the DC Aura flow
 * and the Developer Console SOQL flow.
 */
window.__SF_DC_CSV__ = (function () {
  'use strict';

  /**
   * Extract an ordered array of column names from whatever shape metadata is.
   *
   * Data Cloud API returns metadata as an array of objects.  Each object may
   * use different property names across API versions; we try the common ones.
   */
  function getColumnNames(metadata) {
    if (Array.isArray(metadata)) {
      return metadata.map(
        (col) =>
          col.name ??
          col.label ??
          col.displayName ??
          col.columnName ??
          col.fieldName ??
          String(col)
      );
    }
    if (metadata && Array.isArray(metadata.fields)) {
      return metadata.fields.map(
        (f) => f.name ?? f.label ?? f.fieldName ?? String(f)
      );
    }
    return [];
  }

  function escapeCell(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    // Wrap in quotes if the value contains a delimiter, quote, or line break
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /**
   * Build a CSV string from a DC Aura accumulator entry.
   * Each dataRow entry is { row: [val1, val2, …] }.
   */
  function buildCSV(acc) {
    const columns = getColumnNames(acc.metadata);
    const lines = [];

    // Log the raw shapes so key-mapping issues are visible in DevTools → Console
    if (acc.dataRows.length > 0) {
      console.debug('[SF DC CSV Exporter] metadata[0]:', JSON.stringify(acc.metadata[0]));
      console.debug('[SF DC CSV Exporter] dataRows[0]: ', JSON.stringify(acc.dataRows[0]));
      console.debug('[SF DC CSV Exporter] resolved columns:', columns);
    }

    // Header row
    if (columns.length > 0) {
      lines.push(columns.map(escapeCell).join(','));
    }

    for (const entry of acc.dataRows) {
      // Each entry is { row: [val1, val2, …] } — unwrap the inner array
      const values = Array.isArray(entry?.row) ? entry.row : entry;
      lines.push(values.map(escapeCell).join(','));
    }

    return lines.join('\r\n');
  }

  /**
   * Build a CSV string from REST SOQL records.
   *
   * Records are plain objects with a nested `attributes` key added by SF:
   *   { attributes: { type: "Account", url: "…" }, Id: "…", Name: "…" }
   *
   * We drop `attributes` from the CSV and use the remaining keys (in SELECT
   * order, which Object.keys preserves) as column headers.  Nested objects
   * (sub-selects / relationship fields) are serialised as JSON strings.
   */
  function buildCSVFromSoqlRecords(records) {
    if (records.length === 0) return '';
    const columns = Object.keys(records[0]).filter((k) => k !== 'attributes');

    console.debug('[SF DC CSV Exporter] SOQL columns:', columns);
    console.debug('[SF DC CSV Exporter] SOQL records[0]:', JSON.stringify(records[0]));

    const lines = [columns.map(escapeCell).join(',')];
    for (const record of records) {
      lines.push(
        columns.map((col) => {
          const val = record[col];
          // Relationship sub-selects return nested objects — flatten to JSON
          if (val !== null && typeof val === 'object') return escapeCell(JSON.stringify(val));
          return escapeCell(val);
        }).join(',')
      );
    }
    return lines.join('\r\n');
  }

  function triggerDownload(acc) {
    const csv = buildCSV(acc);
    // Prepend UTF-8 BOM so Excel opens the file with correct encoding
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const shortId = acc.queryId ? String(acc.queryId).slice(-8) : 'query';
    a.download = `dc-query-${shortId}-${ts}.csv`;
    a.style.display = 'none';

    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  function triggerSoqlDownload(records) {
    const csv = buildCSVFromSoqlRecords(records);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    // Use the SF object type from the first record's attributes if available
    const objectType = (records[0]?.attributes?.type ?? 'soql').toLowerCase();
    a.download = `${objectType}-query-${ts}.csv`;
    a.style.display = 'none';

    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  return { getColumnNames, escapeCell, buildCSV, buildCSVFromSoqlRecords, triggerDownload, triggerSoqlDownload };
})();

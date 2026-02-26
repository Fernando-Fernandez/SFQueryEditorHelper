/**
 * content-csv.js — CSV/TSV generation and download for SF Query Editor Helper.
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

  /** CSV cell escaping: wraps in double-quotes when the value contains a
   *  comma, quote, or line break. */
  function escapeCell(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /** TSV cell escaping: replaces tabs and newlines with spaces so they don't
   *  break column/row boundaries when pasted into Google Sheets. */
  function escapeTsvCell(val) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/[\t\r\n]+/g, ' ');
  }

  // ── SOQL relationship flattening ────────────────────────────────────────────

  /**
   * Build an ordered list of column specs for a SOQL record set.
   *
   * For top-level scalar fields this is trivial.  For sub-select relationship
   * fields (e.g. `Contacts` → `{ records:[…], totalSize, done }`) we expand
   * them into `Relationship.SubField` columns.  Multiple related records are
   * joined with " | " in a single cell so the parent row count is preserved.
   *
   * Returns an array of { header: string, get: (record) => string }.
   */
  function getSoqlColumnSpecs(records) {
    if (records.length === 0) return [];

    const topKeys = Object.keys(records[0]).filter((k) => k !== 'attributes');
    const specs = [];

    for (const key of topKeys) {
      // Find the first non-null value to determine the field's type
      let sample = null;
      for (const r of records) {
        if (r[key] != null) { sample = r[key]; break; }
      }

      if (sample !== null && typeof sample === 'object' && Array.isArray(sample.records)) {
        // Sub-select: discover sub-columns from the first non-empty relationship
        let subKeys = [];
        for (const r of records) {
          const rel = r[key];
          if (rel?.records?.length > 0) {
            subKeys = Object.keys(rel.records[0]).filter((k) => k !== 'attributes');
            break;
          }
        }

        if (subKeys.length === 0) {
          // Empty sub-select across all rows — emit a single blank column
          specs.push({ header: key, get: () => '' });
        } else {
          for (const subKey of subKeys) {
            specs.push({
              header: `${key}.${subKey}`,
              get: (r) => {
                const rel = r[key];
                if (!Array.isArray(rel?.records) || rel.records.length === 0) return '';
                return rel.records
                  .map((sub) => (sub[subKey] == null ? '' : String(sub[subKey])))
                  .join(' | ');
              },
            });
          }
        }
      } else {
        specs.push({
          header: key,
          get: (r) => {
            const v = r[key];
            if (v == null) return '';
            if (typeof v === 'object') return JSON.stringify(v);
            return String(v);
          },
        });
      }
    }

    return specs;
  }

  // ── DC (Aura) builders ──────────────────────────────────────────────────────

  /**
   * Build a CSV string from a DC Aura accumulator entry.
   * Each dataRow entry is { row: [val1, val2, …] }.
   */
  function buildCSV(acc) {
    const columns = getColumnNames(acc.metadata);
    const lines = [];

    if (acc.dataRows.length > 0) {
      console.debug('[SF DC CSV Exporter] metadata[0]:', JSON.stringify(acc.metadata[0]));
      console.debug('[SF DC CSV Exporter] dataRows[0]: ', JSON.stringify(acc.dataRows[0]));
      console.debug('[SF DC CSV Exporter] resolved columns:', columns);
    }

    if (columns.length > 0) {
      lines.push(columns.map(escapeCell).join(','));
    }
    for (const entry of acc.dataRows) {
      const values = Array.isArray(entry?.row) ? entry.row : entry;
      lines.push(values.map(escapeCell).join(','));
    }
    return lines.join('\r\n');
  }

  /** TSV version of buildCSV — tab-separated, for clipboard → Google Sheets. */
  function buildTSV(acc) {
    const columns = getColumnNames(acc.metadata);
    const lines = [];
    if (columns.length > 0) {
      lines.push(columns.map(escapeTsvCell).join('\t'));
    }
    for (const entry of acc.dataRows) {
      const values = Array.isArray(entry?.row) ? entry.row : entry;
      lines.push(values.map(escapeTsvCell).join('\t'));
    }
    return lines.join('\n');
  }

  // ── SOQL builders ───────────────────────────────────────────────────────────

  /**
   * Build a CSV string from REST SOQL records.
   *
   * Relationship sub-selects (e.g. Contacts, OpportunityLineItems) are
   * expanded into `Relationship.SubField` columns rather than being
   * JSON-stringified.  Multiple related records are joined with " | ".
   */
  function buildCSVFromSoqlRecords(records) {
    if (records.length === 0) return '';
    const specs = getSoqlColumnSpecs(records);

    console.debug('[SF DC CSV Exporter] SOQL columns:', specs.map((s) => s.header));
    console.debug('[SF DC CSV Exporter] SOQL records[0]:', JSON.stringify(records[0]));

    const lines = [specs.map((s) => escapeCell(s.header)).join(',')];
    for (const record of records) {
      lines.push(specs.map((s) => escapeCell(s.get(record))).join(','));
    }
    return lines.join('\r\n');
  }

  /** TSV version of buildCSVFromSoqlRecords — for clipboard → Google Sheets. */
  function buildTSVFromSoqlRecords(records) {
    if (records.length === 0) return '';
    const specs = getSoqlColumnSpecs(records);
    const lines = [specs.map((s) => escapeTsvCell(s.header)).join('\t')];
    for (const record of records) {
      lines.push(specs.map((s) => escapeTsvCell(s.get(record))).join('\t'));
    }
    return lines.join('\n');
  }

  // ── Download triggers ───────────────────────────────────────────────────────

  function triggerDownload(acc) {
    const csv = buildCSV(acc);
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
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  }

  function triggerSoqlDownload(records) {
    const csv = buildCSVFromSoqlRecords(records);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const objectType = (records[0]?.attributes?.type ?? 'soql').toLowerCase();
    a.download = `${objectType}-query-${ts}.csv`;
    a.style.display = 'none';

    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  }

  return {
    getColumnNames,
    escapeCell,
    buildCSV,
    buildTSV,
    buildCSVFromSoqlRecords,
    buildTSVFromSoqlRecords,
    triggerDownload,
    triggerSoqlDownload,
  };
})();

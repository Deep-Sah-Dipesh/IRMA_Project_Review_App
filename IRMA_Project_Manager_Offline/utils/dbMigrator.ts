import * as SQLite from 'expo-sqlite';
import Papa from 'papaparse';
import { MONITORING_CSV, IRMA_CSV } from '../constants/csvData';

const toSqlSafe = (val: any) => {
  if (val === undefined || val === null) return "";
  return String(val).trim();
};

const sanitizeId = (val: any) => {
  if (!val) return "";
  return String(val).trim().replace(/\//g, '-');
};

const extractCleanCsv = (rawCsv: string) => {
  const startIndex = rawCsv.indexOf("Sno.");
  return startIndex !== -1 ? rawCsv.substring(startIndex).trim() : rawCsv.trim();
};

export const getExpectedCounts = () => {
  const cleanMon = extractCleanCsv(MONITORING_CSV);
  const monParsed = Papa.parse(cleanMon, { header: true, skipEmptyLines: true });
  const tendersCount = monParsed.data.filter((r: any) => r['Project ID']).length;

  const cleanIrma = extractCleanCsv(IRMA_CSV);
  const irmaParsed = Papa.parse(cleanIrma, { header: true, skipEmptyLines: true });
  const obsCount = irmaParsed.data.filter((r: any) => r['Project Code']).length;

  return { tenders: tendersCount, observations: obsCount };
};

export const syncStaticData = async (db: SQLite.SQLiteDatabase) => {
  try {
    // ATOMIC TRANSACTION: If an error is thrown anywhere inside this block, 
    // SQLite automatically discards all partial data and rolls back the tables.
    await db.withTransactionAsync(async () => {
      
      // 1. Prepare Schema
      await db.runAsync("DROP TABLE IF EXISTS tenders");
      await db.runAsync("DROP TABLE IF EXISTS observations");
      
      await db.runAsync(`
        CREATE TABLE tenders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT, ulb TEXT, state TEXT, district TEXT, 
          project_type TEXT, project_title TEXT, tender_id TEXT, tender_name TEXT, 
          nit_date TEXT, award_date TEXT, bidder_name TEXT, capex TEXT, 
          onm TEXT, scope TEXT, physical_progress TEXT, financial_progress TEXT
        )
      `);
      
      await db.runAsync(`
        CREATE TABLE observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT, project_code TEXT, state TEXT, 
          ulb TEXT, project_type TEXT, project_title TEXT, visit_date TEXT, 
          form_type TEXT, category TEXT, component TEXT, severity TEXT, observations TEXT
        )
      `);

      // 2. Parse & Insert Tenders
      const cleanMon = extractCleanCsv(MONITORING_CSV);
      const monParsed = Papa.parse(cleanMon, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() });
      
      const tStmt = await db.prepareAsync(`
        INSERT INTO tenders (
          project_id, ulb, state, district, project_type, project_title, tender_id, tender_name, 
          nit_date, award_date, bidder_name, capex, onm, scope, physical_progress, financial_progress
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);

      let tenderCount = 0;
      
      // GUARANTEED CLEANUP: Ensure statement finalizes even if parsing crashes
      try {
        for (const r of monParsed.data as any[]) {
          if (!r['Project ID']) continue;
          await tStmt.executeAsync([
            sanitizeId(r['Project ID']), toSqlSafe(r['ULB']), toSqlSafe(r['State']), toSqlSafe(r['District']), 
            toSqlSafe(r['Project Type']), toSqlSafe(r['Project Title']), sanitizeId(r['Tender ID']), 
            toSqlSafe(r['Tender Name']), toSqlSafe(r['NIT Issued Date']), toSqlSafe(r['Contract Award Date']), 
            toSqlSafe(r['Successful Bidder Name']), toSqlSafe(r['CAPEX (in Cr.)']), toSqlSafe(r['O&M (in CR.)']),
            toSqlSafe(r['Brief Scope of Work']), toSqlSafe(r['Physical Progress (in %)']), toSqlSafe(r['Financial Progress (in %)'])
          ]);
          tenderCount++;
        }
      } finally {
        await tStmt.finalizeAsync();
      }

      // 3. Parse & Insert Observations
      const cleanIrma = extractCleanCsv(IRMA_CSV);
      const irmaParsed = Papa.parse(cleanIrma, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() });

      const oStmt = await db.prepareAsync(`
        INSERT INTO observations (
          project_code, state, ulb, project_type, project_title, visit_date, 
          form_type, category, component, severity, observations
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `);

      let obsCount = 0;
      
      try {
        for (const r of irmaParsed.data as any[]) {
          if (!r['Project Code']) continue;
          await oStmt.executeAsync([
            sanitizeId(r['Project Code']), toSqlSafe(r['State']), toSqlSafe(r['ULB']), toSqlSafe(r['Project Type']), 
            toSqlSafe(r['Project Title']), toSqlSafe(r['Date of Visit']), toSqlSafe(r['Form-Type']), 
            toSqlSafe(r['Category']), toSqlSafe(r['Component']), toSqlSafe(r['Severity']), toSqlSafe(r['IRMA Major Observations'])
          ]);
          obsCount++;
        }
      } finally {
        await oStmt.finalizeAsync();
      }

      // 4. Finalize Sync Flag
      // Because this is inside the transaction, it ONLY writes if ALL inserts succeeded.
      await db.runAsync("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync_v2', datetime('now'))");
      console.log(`Migration Complete: ${tenderCount} Tenders, ${obsCount} Observations.`);
    });
  } catch (error) {
    console.error("Migration Error:", error);
    throw error;
  }
};
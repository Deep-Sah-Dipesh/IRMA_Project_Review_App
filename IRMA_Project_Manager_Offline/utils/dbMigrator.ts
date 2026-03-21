import * as SQLite from 'expo-sqlite';
import Papa from 'papaparse';
import { MONITORING_CSV, IRMA_CSV } from '../constants/csvData';

const toSqlSafe = (val: any) => {
  if (val === undefined || val === null) return "";
  return String(val).trim();
};

const extractCleanCsv = (rawCsv: string) => {
  const startIndex = rawCsv.indexOf("Sno.");
  return startIndex !== -1 ? rawCsv.substring(startIndex).trim() : rawCsv.trim();
};

export const syncStaticData = async () => {
  const db = await SQLite.openDatabaseAsync('civil_projects.db');

  try {
    await db.withTransactionAsync(async () => {
      // 1. TENDERS
      const cleanMon = extractCleanCsv(MONITORING_CSV);
      const monParsed = Papa.parse(cleanMon, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() });
      
      // Use INSERT OR REPLACE to handle duplicates gracefully
      const tStmt = await db.prepareAsync(`
        INSERT OR REPLACE INTO tenders (
          project_id, ulb, state, district, project_type, project_title, tender_id, tender_name, 
          nit_date, award_date, bidder_name, capex, onm, scope, physical_progress, financial_progress
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);

      let tenderCount = 0;
      for (const r of monParsed.data as any[]) {
        if (!r['Project ID'] || !r['Tender ID']) continue; // Require both for compound key
        await tStmt.executeAsync([
          toSqlSafe(r['Project ID']), toSqlSafe(r['ULB']), toSqlSafe(r['State']), toSqlSafe(r['District']), 
          toSqlSafe(r['Project Type']), toSqlSafe(r['Project Title']), toSqlSafe(r['Tender ID']), 
          toSqlSafe(r['Tender Name']), toSqlSafe(r['NIT Issued Date']), toSqlSafe(r['Contract Award Date']), 
          toSqlSafe(r['Successful Bidder Name']), toSqlSafe(r['CAPEX (in Cr.)']), toSqlSafe(r['O&M (in CR.)']),
          toSqlSafe(r['Brief Scope of Work']), toSqlSafe(r['Physical Progress (in %)']), toSqlSafe(r['Financial Progress (in %)'])
        ]);
        tenderCount++;
      }
      await tStmt.finalizeAsync();
      console.log(`✅ Seeded ${tenderCount} Tenders`);

      // 2. OBSERVATIONS
      const cleanIrma = extractCleanCsv(IRMA_CSV);
      const irmaParsed = Papa.parse(cleanIrma, { header: true, skipEmptyLines: true, transformHeader: h => h.trim() });

      const oStmt = await db.prepareAsync(`
        INSERT OR REPLACE INTO observations (
          project_code, state, ulb, project_type, project_title, visit_date, 
          form_type, category, component, severity, observations
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `);

      let obsCount = 0;
      for (const r of irmaParsed.data as any[]) {
        if (!r['Project Code']) continue;
        await oStmt.executeAsync([
          toSqlSafe(r['Project Code']), toSqlSafe(r['State']), toSqlSafe(r['ULB']), toSqlSafe(r['Project Type']), 
          toSqlSafe(r['Project Title']), toSqlSafe(r['Date of Visit']), toSqlSafe(r['Form-Type']), 
          toSqlSafe(r['Category']), toSqlSafe(r['Component']), toSqlSafe(r['Severity']), toSqlSafe(r['IRMA Major Observations'])
        ]);
        obsCount++;
      }
      await oStmt.finalizeAsync();
      console.log(`✅ Seeded ${obsCount} Observations`);

      await db.runAsync("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync', datetime('now'))");
    });
  } catch (error) {
    console.error("Migration Error:", error);
    throw error;
  }
};
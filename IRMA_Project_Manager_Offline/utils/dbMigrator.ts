import * as SQLite from 'expo-sqlite';
import Papa from 'papaparse';
import { TENDER_CSV, PROJ_DTL_CSV, REVIEW1_CSV, OBS_CSV } from '../constants/csvData';

const toSqlSafe = (val: any) => (val === undefined || val === null ? "" : String(val).trim());
const sanitizeId = (val: any) => (!val ? "" : String(val).trim().replace(/[\/\\]/g, '-'));

const extractCleanCsv = (rawCsv: string) => {
  const startIndex = rawCsv.indexOf("Sno.");
  return startIndex !== -1 ? rawCsv.substring(startIndex).trim() : rawCsv.trim();
};

export const syncStaticData = async (db: SQLite.SQLiteDatabase) => {
  try {
    await db.execAsync(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT);`);
    const isSeeded = await db.getFirstAsync<{value: string}>("SELECT value FROM metadata WHERE key = 'last_sync_v4_final'");
    if (isSeeded) return;

    console.log("Starting DB Migration (4-Way Join)...");

    await db.execAsync(`
      DROP TABLE IF EXISTS tenders;
      DROP TABLE IF EXISTS observations;
      
      CREATE TABLE IF NOT EXISTS tenders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, tender_id TEXT, project_type TEXT, project_title TEXT, state TEXT, district TEXT, ulb TEXT,
        nit_date TEXT, award_date TEXT, bidder_name TEXT, capex TEXT, o_m TEXT, scope TEXT, physical_progress TEXT, financial_progress TEXT,
        no_of_tenders TEXT, est_tpc TEXT, est_capex TEXT, est_o_m TEXT, est_dpr_date TEXT, est_award_date TEXT, est_completion_date TEXT, shpsc_date TEXT, dpr_prep_date TEXT, sltc_date TEXT, sch_completion_date TEXT, awarded_capex TEXT, awarded_o_m TEXT, awarded_tpc TEXT,
        irma_personnel TEXT, designation TEXT, contact_number TEXT, email TEXT, state_officer TEXT, state_officer_contact TEXT, state_officer_email TEXT
      );

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_code TEXT, state TEXT, ulb TEXT, project_type TEXT, 
        project_title TEXT, visit_date TEXT, form_type TEXT, category TEXT, component TEXT, severity TEXT, observations TEXT
      );
    `);

    const tendersParsed = Papa.parse(extractCleanCsv(TENDER_CSV || ""), { header: true, skipEmptyLines: true });
    const projDtlParsed = Papa.parse(extractCleanCsv(PROJ_DTL_CSV || ""), { header: true, skipEmptyLines: true });
    const review1Parsed = Papa.parse(extractCleanCsv(REVIEW1_CSV || ""), { header: true, skipEmptyLines: true });
    const obsParsed = Papa.parse(extractCleanCsv(OBS_CSV || ""), { header: true, skipEmptyLines: true });

    const projMap = new Map();
    (projDtlParsed.data || []).forEach((r: any) => { if (r['Project ID']) projMap.set(sanitizeId(r['Project ID']), r); });

    const reviewMap = new Map();
    (review1Parsed.data || []).forEach((r: any) => { if (r['Project Code']) reviewMap.set(sanitizeId(r['Project Code']), r); });

    await db.withTransactionAsync(async () => {
      const tStmt = await db.prepareAsync(`INSERT INTO tenders (project_id, tender_id, project_type, project_title, state, district, ulb, nit_date, award_date, bidder_name, capex, o_m, scope, physical_progress, financial_progress, no_of_tenders, est_tpc, est_capex, est_o_m, est_dpr_date, est_award_date, est_completion_date, shpsc_date, dpr_prep_date, sltc_date, sch_completion_date, awarded_capex, awarded_o_m, awarded_tpc, irma_personnel, designation, contact_number, email, state_officer, state_officer_contact, state_officer_email) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

      for (const r of (tendersParsed.data || [])) {
        const pId = sanitizeId((r as any)['Project ID']);
        if (!pId) continue;
        const pMatch = projMap.get(pId) || {};
        const rMatch = reviewMap.get(pId) || {};

        await tStmt.executeAsync([
          pId, sanitizeId((r as any)['Tender ID']), toSqlSafe((r as any)['Project Type']), toSqlSafe((r as any)['Project Title']), toSqlSafe((r as any)['State']), toSqlSafe((r as any)['District']), toSqlSafe((r as any)['ULB']),
          toSqlSafe((r as any)['NIT Issued Date']), toSqlSafe((r as any)['Contract Award Date']), toSqlSafe((r as any)['Successful Bidder Name']), toSqlSafe((r as any)['CAPEX (in Cr.)']), toSqlSafe((r as any)['O&M (in CR.)']), toSqlSafe((r as any)['Brief Scope of Work']), toSqlSafe((r as any)['Physical Progress (in %)']), toSqlSafe((r as any)['Financial Progress (in %)']),
          toSqlSafe(pMatch['No. of Tenders']), toSqlSafe(pMatch['Est. TPC (in Cr.)']), toSqlSafe(pMatch['Est. CAPEX (in Cr.)']), toSqlSafe(pMatch['Est. O&M (in Cr.)']), toSqlSafe(pMatch['Est. DPR Preparation Date']), toSqlSafe(pMatch['Est. Project Award Date']), toSqlSafe(pMatch['Est. Project Completion Date']), toSqlSafe(pMatch['SHPSC Approval Date']), toSqlSafe(pMatch['DPR Preparation Date']), toSqlSafe(pMatch['SLTC Approval Date']), toSqlSafe(pMatch['Sch. Project Completion Date']), toSqlSafe(pMatch['Awarded CAPEX (in Cr.)']), toSqlSafe(pMatch['Awarded O&M (in Cr.)']), toSqlSafe(pMatch['Awarded TPC (in Cr.)']),
          toSqlSafe(rMatch['IRMA Personel']), toSqlSafe(rMatch['Designation']), toSqlSafe(rMatch['Contact Number']), toSqlSafe(rMatch['E-mail']), toSqlSafe(rMatch['State Officer']), toSqlSafe(rMatch['State Officer Contact']), toSqlSafe(rMatch['State Officer E-mail'])
        ]);
      }
      await tStmt.finalizeAsync();

      const oStmt = await db.prepareAsync(`INSERT INTO observations (project_code, state, ulb, project_type, project_title, visit_date, form_type, category, component, severity, observations) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const r of (obsParsed.data || [])) {
        if (!(r as any)['Project Code']) continue;
        await oStmt.executeAsync([sanitizeId((r as any)['Project Code']), toSqlSafe((r as any)['State']), toSqlSafe((r as any)['ULB']), toSqlSafe((r as any)['Project Type']), toSqlSafe((r as any)['Project Title']), toSqlSafe((r as any)['Date of Visit']), toSqlSafe((r as any)['Form-Type']), toSqlSafe((r as any)['Category']), toSqlSafe((r as any)['Component']), toSqlSafe((r as any)['Severity']), toSqlSafe((r as any)['IRMA Major Observations'])]);
      }
      await oStmt.finalizeAsync();
      await db.runAsync("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync_v4_final', datetime('now'))");
    });
    console.log("✅ Sync Complete!");
  } catch (error) {
    console.error("Migration failed:", error);
  }
};
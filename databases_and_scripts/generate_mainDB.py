import pandas as pd
import sqlite3
import os

def get_val(row, *keys):
    """
    Safely extract and sanitize values using case-insensitive key matching.
    Checks multiple possible column name variations to prevent 100% Null errors.
    """
    if row is None or row.empty:
        return ''
    for k in keys:
        k_lower = k.lower()
        if k_lower in row.index and pd.notna(row[k_lower]):
            val = str(row[k_lower]).strip()
            
            # FIX: Strip Pandas-injected '.0' from phone numbers and integer counters
            # Ensures we only strip it from purely numeric values, ignoring text like "Version 2.0"
            if val.endswith('.0') and val[:-2].replace('-', '').isdigit():
                val = val[:-2]
                
            if val.lower() not in ['nan', 'none', 'nat', '<na>', '']:
                return val
    return ''

def build_sqlite_db():
    print("Starting Database Generation (with robust case-insensitive mapping & row filtering)...")
    project_root = os.path.dirname(os.path.abspath(__file__))
    
    # Read RAW files directly to avoid data loss from strict cleaning scripts
    files = {
        'TENDER': os.path.join(project_root, "Monitoring_Data-Tender_Details.csv"),
        'PROJ_DTL': os.path.join(project_root, "Monitoring_Data-Project_Details-20260701.csv"),
        'REVIEW1': os.path.join(project_root, "IRMA_Review_Data-Review1.csv"),
        'REVIEW_NEW': os.path.join(project_root, "IRMA_Review_Data-Review8-20260701.csv"),
        'OBS': os.path.join(project_root, "IRMA_Review_Data-Major_Observation-20260701.csv")
    }
    
    # Safe fallbacks if raw files were overwritten/replaced by the cleaned versions
    if not os.path.exists(files['PROJ_DTL']): files['PROJ_DTL'] = os.path.join(project_root, "Cleaned_Project_Details-20260701.csv")
    if not os.path.exists(files['REVIEW_NEW']): files['REVIEW_NEW'] = os.path.join(project_root, "Cleaned_Review_Data-20260701.csv")
    if not os.path.exists(files['OBS']): files['OBS'] = os.path.join(project_root, "Cleaned_Major_Observation-20260701.csv")
    
    db_path = os.path.join(project_root, "mainDataBase_20260701.db")
    if os.path.exists(db_path):
        os.remove(db_path)
        
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # 1. Exact Original Schema Restored
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS tenders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, tender_id TEXT, tender_name TEXT,
        project_type TEXT, project_title TEXT, state TEXT, district TEXT, ulb TEXT,
        nit_date TEXT, award_date TEXT, bidder_name TEXT, capex TEXT, om TEXT, scope TEXT,
        physical_progress TEXT, financial_progress TEXT, expenditure TEXT, finance_received TEXT,
        excess_expenditure TEXT, justification TEXT, actual_completion_date TEXT,
        images TEXT, updated_on TEXT
    )''')
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS project_details (
        project_id TEXT PRIMARY KEY, state TEXT, district TEXT, ulb TEXT,
        project_type TEXT, project_title TEXT, no_of_tenders TEXT,
        physical_progress TEXT, financial_progress TEXT,
        sch_project_completion_date TEXT, actual_completion_date TEXT, 
        water_body_name TEXT, area TEXT, latitude TEXT, longitude TEXT,
        est_capex TEXT, est_om TEXT, awarded_capex TEXT, awarded_om TEXT,
        irma_personnel TEXT, designation TEXT, contact TEXT, email TEXT,
        state_officer TEXT, so_contact TEXT, so_email TEXT
    )''')

    cursor.execute('''
    CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_code TEXT, state TEXT, ulb TEXT, 
        project_type TEXT, project_title TEXT, visit_date TEXT, form_type TEXT, 
        category TEXT, component TEXT, severity TEXT, observations TEXT
    )''')

    cursor.execute('''CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)''')

    # 2. Process Tenders 
    if os.path.exists(files['TENDER']):
        print("Processing Tenders...")
        df_tenders = pd.read_csv(files['TENDER'], low_memory=False).dropna(how='all')
        df_tenders.columns = df_tenders.columns.str.strip().str.lower()
        
        for _, row in df_tenders.iterrows():
            pid = get_val(row, 'Project ID')
            if not pid: continue  # Failsafe: Skip completely empty rows
            
            cursor.execute('''
            INSERT INTO tenders (
                project_id, tender_id, tender_name, project_type, project_title, state, district,
                ulb, nit_date, award_date, bidder_name, capex, om, scope, physical_progress,
                financial_progress, expenditure, finance_received, excess_expenditure,
                justification, actual_completion_date, images, updated_on
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ''', (
                pid, get_val(row, 'Tender ID'), get_val(row, 'Tender Name'),
                get_val(row, 'Project Type'), get_val(row, 'Project Title'), get_val(row, 'State'),
                get_val(row, 'District'), get_val(row, 'ULB'), 
                get_val(row, 'NIT Issued Date', 'NIT Date'),
                get_val(row, 'Contract Award Date', 'Award Date'), 
                get_val(row, 'Successful Bidder Name', 'Bidder Name'),
                get_val(row, 'CAPEX (in Cr.)', 'Capex (in Cr.)', 'Capex'),
                get_val(row, 'O&M (in CR.)', 'O&M (in Cr.)', 'O&M'),
                get_val(row, 'Brief Scope of Work', 'Scope'),
                get_val(row, 'Physical Progress (in %)', 'Physical Progress'),
                get_val(row, 'Financial Progress (in %)', 'Financial Progress'),
                get_val(row, 'Expenditure Incurred (in Cr.)', 'Expenditure'),
                get_val(row, 'Finance Received (in CR.)', 'Finance Received (in Cr.)', 'Finance Received'),
                get_val(row, 'Excess Expenditure incurred (in Cr.)', 'Excess Expenditure'),
                get_val(row, 'justification for excess expenditure incurred', 'Justification'), 
                get_val(row, 'Actual Completion Date'),
                get_val(row, 'Images', ''), get_val(row, 'Updated On', '')
            ))

    # 3. Process Project Details with Historical Review Dictionary Overlay
    if os.path.exists(files['PROJ_DTL']):
        print("Processing Project Details & Updating Reviews (Historical Merge)...")
        
        skip = 0
        with open(files['PROJ_DTL'], 'r', encoding='utf-8') as f:
            if ',,,,' in f.readline(): skip = 5
            
        df_proj = pd.read_csv(files['PROJ_DTL'], low_memory=False, skiprows=skip).dropna(how='all')
        df_proj.columns = df_proj.columns.str.strip().str.lower()
        
        rev_lookup = {}
        
        # Base: Load Review 1 Data 
        if os.path.exists(files['REVIEW1']):
            df_rev1 = pd.read_csv(files['REVIEW1'], low_memory=False).dropna(how='all')
            df_rev1.columns = df_rev1.columns.str.strip().str.lower()
            for _, row in df_rev1.iterrows():
                code = get_val(row, 'Project Code')
                if code: rev_lookup[code] = row
                
        # Overlay: Load Review 8 Data
        if os.path.exists(files['REVIEW_NEW']):
            df_rev_new = pd.read_csv(files['REVIEW_NEW'], low_memory=False).dropna(how='all')
            df_rev_new.columns = df_rev_new.columns.str.strip().str.lower()
            for _, row in df_rev_new.iterrows():
                code = get_val(row, 'Project Code')
                if code: rev_lookup[code] = row
        
        for _, row in df_proj.iterrows():
            pid = get_val(row, 'Project ID')
            if not pid: continue  # Failsafe: Skip completely empty rows
            
            rev = rev_lookup.get(pid, pd.Series(dtype=object))
            
            cursor.execute('''
            INSERT OR REPLACE INTO project_details (
                project_id, state, district, ulb, project_type,
                project_title, no_of_tenders, physical_progress,
                financial_progress, sch_project_completion_date, actual_completion_date,
                water_body_name, area, latitude, longitude,
                est_capex, est_om, awarded_capex, awarded_om,
                irma_personnel, designation, contact, email,
                state_officer, so_contact, so_email
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ''', (
                pid, get_val(row, 'State'), get_val(row, 'District'), get_val(row, 'ULB'),
                get_val(row, 'Project Type'), get_val(row, 'Project Title'),
                get_val(row, 'No. of Tenders'),
                get_val(row, 'Physical Progress (in %)', 'Physical Progress'), 
                get_val(row, 'Financial Progress (in %)', 'Financial Progress'),
                get_val(row, 'Sch. Project Completion Date', 'Scheduled Completion Date'), 
                get_val(row, 'Actual Completion Date'),
                get_val(row, 'Water Body/Park Name', 'Water Body Name'), 
                get_val(row, 'Area (in sq. km)', 'Area'), 
                get_val(row, 'Latitude'), get_val(row, 'Longitude'),
                
                get_val(row, 'Est. CAPEX (in Cr.)', 'Est. Capex (in Cr.)', 'Estimated Capex (in Cr.)', 'Est. Capex'),
                get_val(row, 'Est. O&M (in Cr.)', 'Estimated O&M (in Cr.)', 'Est. O&M'),
                get_val(row, 'Awarded CAPEX (in Cr.)', 'Awarded Capex (in Cr.)', 'Awarded Capex'),
                get_val(row, 'Awarded O&M (in Cr.)', 'Awarded O&M'),
                
                get_val(rev, 'IRMA Personel', 'IRMA Personnel'), get_val(rev, 'Designation'),
                get_val(rev, 'Contact Number', 'Contact'), get_val(rev, 'E-mail', 'Email'),
                get_val(rev, 'State Officer'), get_val(rev, 'State Officer Contact'),
                get_val(rev, 'State Officer E-mail', 'State Officer Email')
            ))

    # 4. Observations
    if os.path.exists(files['OBS']):
        print("Processing Observations...")
        df_obs = pd.read_csv(files['OBS'], low_memory=False).dropna(how='all')
        df_obs.columns = df_obs.columns.str.strip().str.lower()
        for _, row in df_obs.iterrows():
            code = get_val(row, 'Project Code')
            if not code: continue # Failsafe: Drops the 1,184 empty rows immediately
            
            cursor.execute('''
            INSERT INTO observations (
                project_code, state, ulb, project_type, project_title,
                visit_date, form_type, category, component, severity, observations
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ''', (
                code, get_val(row, 'State'),
                get_val(row, 'ULB'), get_val(row, 'Project Type'),
                get_val(row, 'Project Title'), get_val(row, 'Date of Visit'),
                get_val(row, 'Form-Type', 'Form Type'), get_val(row, 'Category'),
                get_val(row, 'Component'), get_val(row, 'Severity'),
                get_val(row, 'IRMA Major Observations', 'Observations')
            ))

    conn.commit()
    conn.close()
    print(f"✅ Database built successfully: {db_path}")

if __name__ == "__main__":
    build_sqlite_db()
import pandas as pd
import sqlite3
import os

# Keeps empty CSV cells completely blank, avoiding stringified 'nan'
def sanitize(val):
    if pd.isna(val): return ''
    return str(val).strip()

def build_sqlite_db():
    print(" Starting Database Generation...")
    project_root = os.path.dirname(os.path.abspath(__file__))
    
    files = {
        'TENDER': os.path.join(project_root, "Monitoring_Data-Tender_Details.csv"),
        'PROJ_DTL': os.path.join(project_root, "Monitoring_Data-Project_Details.csv"),
        'REVIEW1': os.path.join(project_root, "IRMA_Review_Data-Review1.csv"),
        'OBS': os.path.join(project_root, "IRMA_Review_Data-Major_Observation.csv")
    }
    
    db_path = os.path.join(project_root, "mainDataBase_20260425.db")
    if os.path.exists(db_path):
        os.remove(db_path)
        
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute('''
    CREATE TABLE IF NOT EXISTS tenders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, tender_id TEXT, tender_name TEXT,
        project_type TEXT, project_title TEXT, state TEXT, district TEXT, 
        ulb TEXT, nit_date TEXT, award_date TEXT, bidder_name TEXT, 
        capex TEXT, om TEXT, scope TEXT, physical_progress TEXT, 
        financial_progress TEXT, expenditure TEXT, finance_received TEXT,
        excess_expenditure TEXT, justification TEXT,
        actual_completion_date TEXT, images TEXT, updated_on TEXT
    )''')
    
    # Fully restored schema including Estimates, Awarded amounts, Lat/Lon, and Personnel fields
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
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_code TEXT, state TEXT, 
        ulb TEXT, project_type TEXT, project_title TEXT, visit_date TEXT, 
        form_type TEXT, category TEXT, component TEXT,
        severity TEXT, observations TEXT
    )''')
    
    cursor.execute('''CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)''')

    if os.path.exists(files['TENDER']):
        print("Processing Tenders...")
        df_tender = pd.read_csv(files['TENDER']).fillna('')
        for _, row in df_tender.iterrows():
            cursor.execute('''
            INSERT INTO tenders (
                project_id, tender_id, tender_name, project_type, project_title,
                state, district, ulb, nit_date, award_date, bidder_name,
                capex, om, scope, physical_progress, financial_progress,
                expenditure, finance_received, excess_expenditure,
                justification, actual_completion_date, images, updated_on
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ''', (
                sanitize(row.get('Project ID')), sanitize(row.get('Tender ID')), sanitize(row.get('Tender Name')),
                sanitize(row.get('Project Type')), sanitize(row.get('Project Title')),
                sanitize(row.get('State')), sanitize(row.get('District')),
                sanitize(row.get('ULB')), sanitize(row.get('NIT Issued Date')),
                sanitize(row.get('Contract Award Date')), sanitize(row.get('Successful Bidder Name')),
                sanitize(row.get('CAPEX (in Cr.)')), sanitize(row.get('O&M (in CR.)')),
                sanitize(row.get('Brief Scope of Work')), sanitize(row.get('Physical Progress (in %)')),
                sanitize(row.get('Financial Progress (in %)')), sanitize(row.get('Expenditure Incurred (in Cr.)')),
                sanitize(row.get('Finance Received (in CR.)')), sanitize(row.get('Excess Expenditure incurred (in Cr.)')),
                sanitize(row.get('justification for excess expenditure incurred')), 
                sanitize(row.get('Actual Completion Date')), 
                sanitize(row.get('Images')), sanitize(row.get('Updated On'))
            ))

    if os.path.exists(files['PROJ_DTL']):
        print("Processing Projects & Review Personnel Data...")
        df_proj = pd.read_csv(files['PROJ_DTL']).fillna('')
        
        # Load Review 1 Data to map Personnel correctly
        df_rev = pd.read_csv(files['REVIEW1']).fillna('') if os.path.exists(files['REVIEW1']) else pd.DataFrame()
        rev_lookup = {}
        for _, row in df_rev.iterrows():
            rev_lookup[str(row.get('Project Code'))] = row

        for _, row in df_proj.iterrows():
            pid = sanitize(row.get('Project ID'))
            rev = rev_lookup.get(pid, {})
            
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
                pid, sanitize(row.get('State')), sanitize(row.get('District')), sanitize(row.get('ULB')),
                sanitize(row.get('Project Type')), sanitize(row.get('Project Title')),
                sanitize(row.get('No. of Tenders')),
                sanitize(row.get('Physical Progress (in %)')), sanitize(row.get('Financial Progress (in %)')),
                sanitize(row.get('Sch. Project Completion Date')), sanitize(row.get('Actual Completion Date')),
                sanitize(row.get('Water Body/Park Name')), sanitize(row.get('Area (in sq. km)')), 
                sanitize(row.get('Latitude')), sanitize(row.get('Longitude')),
                sanitize(row.get('Est. CAPEX (in Cr.)')), sanitize(row.get('Est. O&M (in Cr.)')),
                sanitize(row.get('Awarded CAPEX (in Cr.)')), sanitize(row.get('Awarded O&M (in Cr.)')),
                
                # Merged Review 1 Personnel Data
                sanitize(rev.get('IRMA Personel')), sanitize(rev.get('Designation')),
                sanitize(rev.get('Contact Number')), sanitize(rev.get('E-mail')),
                sanitize(rev.get('State Officer')), sanitize(rev.get('State Officer Contact')),
                sanitize(rev.get('State Officer E-mail'))
            ))

    if os.path.exists(files['OBS']):
        print("Processing Observations...")
        df_obs = pd.read_csv(files['OBS']).fillna('')
        for _, row in df_obs.iterrows():
            cursor.execute('''
            INSERT INTO observations (
                project_code, state, ulb, project_type, project_title,
                visit_date, form_type, category, component, severity, observations
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ''', (
                sanitize(row.get('Project Code')), sanitize(row.get('State')),
                sanitize(row.get('ULB')), sanitize(row.get('Project Type')),
                sanitize(row.get('Project Title')), sanitize(row.get('Date of Visit')),
                sanitize(row.get('Form-Type')), sanitize(row.get('Category')),
                sanitize(row.get('Component')), sanitize(row.get('Severity')),
                sanitize(row.get('IRMA Major Observations'))
            ))

    conn.commit()
    conn.close()
    print("✅ Database built successfully.")

if __name__ == "__main__":
    build_sqlite_db()
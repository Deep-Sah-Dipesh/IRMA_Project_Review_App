import pandas as pd
import sqlite3
import os

def build_sqlite_db():
    print(" Starting Database Generation...")
    project_root = os.path.dirname(os.path.abspath(__file__))
    
    files = {
        'TENDER': os.path.join(project_root, "Monitoring_Data-Tender_Details.csv"),
        'PROJ_DTL': os.path.join(project_root, "Monitoring_Data-Project_Details.csv"),
        'REVIEW1': os.path.join(project_root, "IRMA_Review_Data-Review1.csv"),
        'OBS': os.path.join(project_root, "IRMA_Review_Data-Major_Observation.csv")
    }
    
    db_path = os.path.join(project_root, "mainDataBase_30032026.db")
    if os.path.exists(db_path):
        os.remove(db_path)
        
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # Added bidder_name
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS tenders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, tender_id TEXT, project_type TEXT, 
        project_title TEXT, state TEXT, district TEXT, ulb TEXT, nit_date TEXT, award_date TEXT, 
        capex TEXT, om TEXT, scope TEXT, physical_progress TEXT, financial_progress TEXT, 
        expenditure TEXT, completion_date TEXT, bidder_name TEXT
    )''')

    # Added no_of_tenders, est_capex, est_om
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS project_details (
        project_id TEXT PRIMARY KEY, state TEXT, district TEXT, ulb TEXT, project_type TEXT, 
        project_title TEXT, sanctioned_cost TEXT, awarded_capex TEXT, awarded_om TEXT, 
        awarded_tpc TEXT, irma_personnel TEXT, designation TEXT, contact TEXT, email TEXT, 
        state_officer TEXT, so_contact TEXT, so_email TEXT, latitude TEXT, longitude TEXT,
        no_of_tenders TEXT, est_capex TEXT, est_om TEXT
    )''')

    cursor.execute('''
    CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_code TEXT, state TEXT, ulb TEXT, 
        project_type TEXT, project_title TEXT, visit_date TEXT, form_type TEXT, category TEXT, 
        component TEXT, severity TEXT, observations TEXT
    )''')
    
    def sanitize(val):
        if pd.isna(val): return ""
        return str(val).replace('/', '-').replace('\\', '-').strip()

    if os.path.exists(files['TENDER']):
        print("Processing Tenders...")
        df_tender = pd.read_csv(files['TENDER']).fillna('')
        for _, row in df_tender.iterrows():
            # 17 columns inserted
            cursor.execute('''INSERT INTO tenders (project_id, tender_id, project_type, project_title, state, district, ulb, nit_date, award_date, capex, om, scope, physical_progress, financial_progress, expenditure, completion_date, bidder_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
                sanitize(row.get('Project ID')), sanitize(row.get('Tender ID')), row.get('Project Type'), row.get('Project Title'), 
                row.get('State'), row.get('District'), row.get('ULB'), row.get('NIT Issued Date'), row.get('Contract Award Date'), 
                row.get('CAPEX (in Cr.)'), row.get('O&M (in CR.)'), row.get('Brief Scope of Work'), row.get('Physical Progress (in %)'), 
                row.get('Financial Progress (in %)'), row.get('Expenditure Incurred (in Cr.)'), row.get('Actual Completion Date'),
                row.get('Successful Bidder Name')
            ))

    review_data = {}
    if os.path.exists(files['REVIEW1']):
        print("Processing Review1 (Personnel Contacts)...")
        df_rev = pd.read_csv(files['REVIEW1']).fillna('')
        for _, row in df_rev.iterrows():
            pid = sanitize(row.get('Project Code'))
            if pid:
                review_data[pid] = {
                    'irma_personnel': row.get('IRMA Personel', ''),
                    'designation': row.get('Designation', ''),
                    'contact': row.get('Contact Number', ''),
                    'email': row.get('E-mail', ''),
                    'state_officer': row.get('State Officer', ''),
                    'so_contact': row.get('State Officer Contact', ''),
                    'so_email': row.get('State Officer E-mail', '')
                }

    if os.path.exists(files['PROJ_DTL']):
        print("Processing Project Details...")
        df_proj = pd.read_csv(files['PROJ_DTL']).fillna('')
        for _, row in df_proj.iterrows():
            pid = sanitize(row.get('Project ID'))
            rev = review_data.get(pid, {})
            lat = row.get('Latitude', row.get('Lat', ''))
            lon = row.get('Longitude', row.get('Long', row.get('Lng', '')))
            
            # 22 columns inserted
            cursor.execute('''INSERT OR REPLACE INTO project_details (project_id, state, district, ulb, project_type, project_title, sanctioned_cost, awarded_capex, awarded_om, awarded_tpc, irma_personnel, designation, contact, email, state_officer, so_contact, so_email, latitude, longitude, no_of_tenders, est_capex, est_om) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
                pid, row.get('State'), row.get('District'), row.get('ULB'), row.get('Project Type'), 
                row.get('Project Title'), row.get('Sanctioned Cost (in Cr.)'), row.get('Awarded CAPEX (in Cr.)'), row.get('Awarded O&M (in Cr.)'), 
                row.get('Awarded TPC (in Cr.)'), 
                rev.get('irma_personnel', ''), rev.get('designation', ''), rev.get('contact', ''), 
                rev.get('email', ''), rev.get('state_officer', ''), rev.get('so_contact', ''), rev.get('so_email', ''),
                str(lat), str(lon),
                row.get('No. of Tenders'), row.get('Est. CAPEX (in Cr.)'), row.get('Est. O&M (in Cr.)')
            ))

    if os.path.exists(files['OBS']):
        print("Processing Observations...")
        df_obs = pd.read_csv(files['OBS']).fillna('')
        for _, row in df_obs.iterrows():
            cursor.execute('''INSERT INTO observations (project_code, state, ulb, project_type, project_title, visit_date, form_type, category, component, severity, observations) VALUES (?,?,?,?,?,?,?,?,?,?,?)''', (
                sanitize(row.get('Project Code')), row.get('State'), row.get('ULB'), row.get('Project Type'), row.get('Project Title'), 
                row.get('Date of Visit'), row.get('Form-Type'), row.get('Category'), row.get('Component'), row.get('Severity'), 
                row.get('IRMA Major Observations')
            ))

    cursor.execute('''CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)''')
    cursor.execute("INSERT OR REPLACE INTO metadata (key, value) VALUES ('db_version', '26032026')")

    conn.commit()
    conn.close()
    print(f"✅ Database successfully built at: {db_path}")

if __name__ == "__main__":
    build_sqlite_db()
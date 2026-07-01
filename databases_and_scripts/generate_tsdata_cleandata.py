import pandas as pd
import os

def clean_csv_data():
    """
    Cleans 4 CSV files, sanitizes IDs for filesystem/URL safety, 
    handles duplicate columns, and generates csvData.ts
    """
    project_root = os.path.dirname(os.path.abspath(__file__))
    
    # Input Files
    files = {
        'TENDER': os.path.join(project_root, "Monitoring_Data-Tender_Details.csv"),
        'PROJ_DTL': os.path.join(project_root, "Monitoring_Data-Project_Details.csv"),
        'REVIEW1': os.path.join(project_root, "IRMA_Review_Data-Review1.csv"),
        'OBS': os.path.join(project_root, "IRMA_Review_Data-Major_Observation.csv")
    }
    
    cleaned_csv_strings = {}
    
    for key, path in files.items():
        if not os.path.exists(path):
            print(f"⚠️ Warning: {path} not found. Skipping.")
            cleaned_csv_strings[key] = ""
            continue
            
        print(f"Processing {key}...")
        df = pd.read_csv(path)
        
        # 1. Clean Duplicate Columns (Pandas adds .1, .2 to duplicates)
        new_cols = []
        for col in df.columns:
            if str(col).endswith('.1'):
                new_cols.append(str(col).replace('.1', '2'))
            elif str(col).endswith('.2'):
                new_cols.append(str(col).replace('.2', '3'))
            else:
                new_cols.append(str(col).strip())
        df.columns = new_cols
        
        # 2. Sanitize ID Columns (Replace / with - to prevent folder path crashes)
        id_columns = ['Project ID', 'Tender ID', 'Project Code']
        for col in id_columns:
            if col in df.columns:
                df[col] = df[col].astype(str).str.replace(r'[/\\]', '-', regex=True).str.strip()
        
        # 3. Clean Text Data (Remove backticks that break TS template literals)
        df = df.fillna('')
        df = df.map(lambda x: str(x).replace('`', "'").replace('\r', ' ').strip() if isinstance(x, str) else x)
        
        # Convert to CSV string without index
        cleaned_csv_strings[key] = df.to_csv(index=False, lineterminator='\n')
        print(f"✅ Cleaned {len(df)} rows for {key}")

    # Generate TypeScript constant file
    print("\n📝 Generating csvData.ts...")
    
    ts_content = f'''// Auto-generated cleaned data from 4 CSV files
// Generated: {pd.Timestamp.now().strftime('%Y-%m-%d %H:%M:%S')}

export const TENDER_CSV = `{cleaned_csv_strings.get('TENDER', '')}`;
export const PROJ_DTL_CSV = `{cleaned_csv_strings.get('PROJ_DTL', '')}`;
export const REVIEW1_CSV = `{cleaned_csv_strings.get('REVIEW1', '')}`;
export const OBS_CSV = `{cleaned_csv_strings.get('OBS', '')}`;
'''
    
    output_file = os.path.join(project_root, "csvData.ts")
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(ts_content)
        
    print(f"✅ Successfully Generated: {output_file}")

if __name__ == "__main__":
    clean_csv_data()
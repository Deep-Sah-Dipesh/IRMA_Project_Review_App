import pandas as pd
import os
import re

def clean_csv_data():
    """
    Clean CSV files by removing TS-breaking characters, formatting all columns, 
    and generating csvData.ts
    """
    
    # Define file paths
    project_root = os.path.dirname(os.path.abspath(__file__))
    monitoring_file = os.path.join(project_root, "Project-Monitoring-Form-Data (3).csv")
    irma_file = os.path.join(project_root, "IRMA-Review-Pro-Data.csv")
    
    # Complete list of columns for each dataset
    monitoring_cols = [
        "Sno.", "ULB", "State", "District", "Project ID", "Project Type", 
        "Project Title", "Tender ID", "Tender Name", "NIT Issued Date", 
        "Contract Award Date", "Successful Bidder Name", "CAPEX (in Cr.)", 
        "O&M (in CR.)", "Brief Scope of Work", "Physical Progress (in %)", 
        "Financial Progress (in %)", "Expenditure Incurred (in Cr.)", 
        "Finance Received (in CR.)", "Excess Expenditure incurred (in Cr.)", 
        "justification for excess expenditure incurred", "Actual Completion Date", 
        "Images", "Updated On"
    ]
    
    irma_cols = [
        "Sno.", "State", "ULB", "Project Code", "Project Type", "Project Title", 
        "Date of Visit", "Form-Type", "Category", "Component", "Severity", 
        "IRMA Major Observations", "Response by State", "Final Comments by IRMA"
    ]
    
    print("🔄 Reading CSV files...")
    
    try:
        monitoring_df = pd.read_csv(monitoring_file, encoding='utf-8', keep_default_na=False, na_values=[''])
        irma_df = pd.read_csv(irma_file, encoding='utf-8', keep_default_na=False, na_values=[''])
        
        # Strip whitespace from headers to ensure accurate column matching
        monitoring_df.columns = monitoring_df.columns.str.strip()
        irma_df.columns = irma_df.columns.str.strip()
        
    except Exception as e:
        print(f"❌ Error reading files: {e}")
        return
    
    print(f"✅ Loaded {len(monitoring_df)} monitoring records")
    print(f"✅ Loaded {len(irma_df)} IRMA records")
    
    # Clean function: strip newlines, backticks, bullets, and normalize spaces
    def clean_value(val):
        if pd.isna(val) or val == '':
            return ""
        
        val = str(val)
        
        # 1. Replace backticks with single quotes (Crucial for TS template literals)
        val = val.replace('`', "'")
        
        # 2. Remove common bullet points
        val = re.sub(r'[•◦▪\u2022\u25E6\u25AA]', '', val)
        
        # 3. Replace newlines, carriage returns, and tabs with a single space
        val = re.sub(r'[\n\r\t]', ' ', val)
        
        # 4. Normalize multiple consecutive spaces to a single space
        val = re.sub(r'\s+', ' ', val)
        
        return val.strip()
    
    print("\n🧹 Cleaning data...")
    
    # Extract existing columns (ignores missing columns safely)
    m_cols_to_use = [c for c in monitoring_cols if c in monitoring_df.columns]
    i_cols_to_use = [c for c in irma_cols if c in irma_df.columns]
    
    monitoring_clean = monitoring_df[m_cols_to_use].copy()
    for col in monitoring_clean.columns:
        monitoring_clean[col] = monitoring_clean[col].apply(clean_value)
        
    irma_clean = irma_df[i_cols_to_use].copy()
    for col in irma_clean.columns:
        irma_clean[col] = irma_clean[col].apply(clean_value)
        
    # Save cleaned CSVs
    monitoring_clean_file = os.path.join(project_root, "Project-Monitoring-Form-Data-Clean.csv")
    irma_clean_file = os.path.join(project_root, "IRMA-Review-Pro-Data-Clean.csv")
    
    # Using quoting=csv.QUOTE_MINIMAL handled inherently by pandas to prevent delimiter issues
    monitoring_clean.to_csv(monitoring_clean_file, index=False, encoding='utf-8')
    irma_clean.to_csv(irma_clean_file, index=False, encoding='utf-8')
    
    print(f"✅ Saved cleaned monitoring data: {monitoring_clean_file}")
    print(f"✅ Saved cleaned IRMA data: {irma_clean_file}")
    
    # Generate TypeScript constant file
    print("\n📝 Generating csvData.ts...")
    
    monitoring_csv = monitoring_clean.to_csv(index=False, lineterminator='\n')
    irma_csv = irma_clean.to_csv(index=False, lineterminator='\n')
    
    # Template strings are safe now since backticks were removed in clean_value
    ts_content = f'''// Auto-generated cleaned data from CSV files
// Generated: {pd.Timestamp.now().strftime('%Y-%m-%d %H:%M:%S')}

// Monitoring Form Data - {len(monitoring_clean)} records
export const MONITORING_CSV = `{monitoring_csv.strip()}`;

// IRMA Review Data - {len(irma_clean)} records
export const IRMA_CSV = `{irma_csv.strip()}`;
'''
    
    # Write to csvData.ts
    output_file = os.path.join(project_root, "IRMA_Project_Manager_Offline", "constants", "csvData.ts")
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(ts_content)
        
    print(f"✅ Generated: {output_file}")
    
    # Print summary
    print("\n" + "="*50)
    print("📊 SUMMARY")
    print("="*50)
    print(f"Monitoring records cleaned: {len(monitoring_clean)} (Cols: {len(m_cols_to_use)})")
    print(f"IRMA records cleaned: {len(irma_clean)} (Cols: {len(i_cols_to_use)})")
    print("\n✨ Data cleaning complete! Ready to use in your app.")

if __name__ == "__main__":
    clean_csv_data()
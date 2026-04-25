import pandas as pd
import os

def clean_csv_data(new_file_path, output_path, old_file_path=None):
    print(f"Starting CSV cleaning process for: {new_file_path}")
    
    # Load data
    df_new = pd.read_csv(new_file_path, low_memory=False)
    
    # 1. Normalize headers (removes hidden trailing spaces)
    df_new.columns = df_new.columns.str.strip()
    
    # 2. Enforce exact column schema (OPTIONAL: Only if old_file_path is provided)
    if old_file_path and os.path.exists(old_file_path):
        df_old = pd.read_csv(old_file_path, nrows=0) 
        expected_columns = df_old.columns.str.strip()
        
        for col in expected_columns:
            if col not in df_new.columns:
                df_new[col] = None 
        
        df_new = df_new[expected_columns]
        print(f"Enforced column schema based on: {old_file_path}")
    
    # 3. Clean string data to prevent database bloat and parsing errors
    string_cols = df_new.select_dtypes(include=['object']).columns
    for col in string_cols:
        df_new[col] = df_new[col].apply(
            lambda x: str(x).strip().replace('\r\n', ' ').replace('\n', ' ') if pd.notna(x) else x
        )
        
    # 4. Remove completely empty rows
    df_new.dropna(how='all', inplace=True)
    
    # 5. Export cleanly
    df_new.to_csv(output_path, index=False, encoding='utf-8')
    print(f"✅ Cleaned CSV successfully saved to: {output_path}\n")

if __name__ == "__main__":
    NEW_OBS = "IRMA_Review_Data-Major_Observation.csv"
    OLD_OBS = "IRMA_Review_Data-Major_Observation-old.csv"
    CLEAN_OBS = "IRMA_Review_Data-Major_Observation_Cleaned.csv"
    
    if os.path.exists(NEW_OBS) and os.path.exists(OLD_OBS):
        clean_csv_data(NEW_OBS, CLEAN_OBS, OLD_OBS)
    else:
        print("❌ Error: Files not found. Please ensure both old and new CSVs are in the directory.")
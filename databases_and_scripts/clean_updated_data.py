import pandas as pd
import os

def clean_and_align_csv(new_file, old_file, output_file, skiprows=0, custom_mappings=None):
    """
    Cleans raw CSVs by stripping whitespace, skipping bad headers, 
    and enforcing the exact column structure of an older reference file.
    """
    print(f"Processing: {new_file}")
    
    # 1. Read new file, handling potential metadata rows at the top
    try:
        df_new = pd.read_csv(new_file, skiprows=skiprows, low_memory=False)
    except FileNotFoundError:
        print(f"Error: {new_file} not found. Skipping.")
        return
        
    df_new.columns = df_new.columns.str.strip()

    # 2. Enforce exact schema of the old reference file
    if os.path.exists(old_file):
        df_old = pd.read_csv(old_file, nrows=0)
        expected_columns = df_old.columns.str.strip()
        
        # Map specific columns if requested (e.g., 'Visit-8' to 'Visit-1')
        if custom_mappings:
            for old_col, new_col in custom_mappings.items():
                if new_col in df_new.columns and old_col in expected_columns:
                    df_new[old_col] = df_new[new_col]

        # Add missing columns as None to prevent schema breakage
        for col in expected_columns:
            if col not in df_new.columns:
                df_new[col] = None 
        
        # Restrict and reorder to match exactly
        df_new = df_new[expected_columns]
        print(f" -> Enforced schema from: {old_file}")
    else:
        print(f" -> Warning: Reference file {old_file} not found. Keeping new schema.")
    
    # 3. Clean string data to prevent DB bloat/parsing errors
    string_cols = df_new.select_dtypes(include=['object']).columns
    for col in string_cols:
        df_new[col] = df_new[col].apply(
            lambda x: str(x).strip().replace('\r\n', ' ').replace('\n', ' ') if pd.notna(x) else x
        )
        
    # 4. Remove entirely empty rows and export
    df_new.dropna(how='all', inplace=True)
    df_new.to_csv(output_file, index=False, encoding='utf-8')
    print(f" -> Cleaned CSV saved to: {output_file}\n")


if __name__ == "__main__":
    # Update 1: Project Details (Bypasses 5 rows of metadata)
    clean_and_align_csv(
        new_file="Monitoring_Data-Project_Details-20260701.csv",
        old_file="Monitoring_Data-Project_Details.csv",
        output_file="Cleaned_Project_Details-20260701.csv",
        skiprows=5
    )

    # Update 2: Major Observations (Latest update mapped to old schema)
    clean_and_align_csv(
        new_file="IRMA_Review_Data-Major_Observation-20260701.csv",
        old_file="IRMA_Review_Data-Major_Observation-20260425.csv",
        output_file="Cleaned_Major_Observation-20260701.csv"
    )

    # Update 3: Review Data (Maps Review-8 data onto Review-1 format)
    clean_and_align_csv(
        new_file="IRMA_Review_Data-Review8-20260701.csv",
        old_file="IRMA_Review_Data-Review1.csv",
        output_file="Cleaned_Review_Data-20260701.csv",
        custom_mappings={'Visit-1': 'Visit-8'}
    )
import sqlite3
import os

def analyze_database():
    db_name = "mainDataBase_20260404.db"
    db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), db_name)
    
    if not os.path.exists(db_path):
        print(f"❌ Database not found at: {db_path}")
        return

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';")
        tables = [row[0] for row in cursor.fetchall()]
        
        print(f"📊 Database Analysis for '{db_name}'\n" + "="*80)
        print(f"Total Tables Found: {len(tables)}\n" + "="*80)
        
        for table in tables:
            cursor.execute(f'SELECT COUNT(*) FROM "{table}";')
            total_rows = cursor.fetchone()[0]
            
            cursor.execute(f'PRAGMA table_info("{table}");')
            columns = cursor.fetchall()
            
            print(f"\n📂 Table: {table}")
            print(f"   Total Rows: {total_rows:,}")
            print(f"   Total Fields: {len(columns)}")
            print(f"   \n   {'Column Name':<30} | {'Type':<12} | {'Valid':<12} | {'Null/Empty'}")
            print("   " + "-"*80)
            
            if total_rows == 0:
                for col in columns:
                    print(f"   {col[1]:<30} | {col[2] if col[2] else 'UNKNOWN':<12} | {'0':<12} | 0")
                continue

            for col in columns:
                col_name = col[1]
                col_type = col[2] if col[2] else "UNKNOWN"
                
                # Count NULLs or empty strings
                query = f'''
                    SELECT SUM(
                        CASE WHEN "{col_name}" IS NULL OR "{col_name}" = '' THEN 1 ELSE 0 END
                    ) FROM "{table}";
                '''
                cursor.execute(query)
                missing_count = cursor.fetchone()[0] or 0
                
                # Derive valid count to avoid a second full table scan
                valid_count = total_rows - missing_count
                
                print(f"   {col_name:<30} | {col_type:<12} | {valid_count:<12,} | {missing_count:,}")
                
        print("\n" + "="*80)
        print("✅ Analysis Complete.")
        
    except sqlite3.Error as e:
        print(f"❌ SQLite error: {e}")
    finally:
        if 'conn' in locals() and conn:
            conn.close()

if __name__ == "__main__":
    analyze_database()
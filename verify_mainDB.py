import sqlite3
import os

def verify_database():
    db_name = "mainDataBase_20260404.db"
    db_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), db_name)
    
    if not os.path.exists(db_path):
        print(f"❌ Database not found at: {db_path}")
        return

    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Execute COUNT queries for all major tables
        queries = {
            "Total Unique Projects": "SELECT COUNT(*) FROM project_details;",
            "Total Unique Tenders": "SELECT COUNT(*) FROM tenders;",
            "Total Observations": "SELECT COUNT(*) FROM observations;"
        }
        
        print(f"📊 Verification Results for '{db_name}':\n" + "-"*40)
        
        for label, query in queries.items():
            cursor.execute(query)
            count = cursor.fetchone()[0]
            print(f"{label:<25}: {count:,}")
            
        print("-" * 40)
        print("✅ Verification Complete.")
        
    except sqlite3.Error as e:
        print(f"❌ SQLite error: {e}")
    finally:
        if conn:
            conn.close()

if __name__ == "__main__":
    verify_database()
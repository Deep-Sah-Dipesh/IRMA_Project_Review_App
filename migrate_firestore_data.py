import firebase_admin
from firebase_admin import credentials, firestore

# Initialize Source App (Old Project)
# Use a unique name to allow multiple app instances
source_cred = credentials.Certificate('./old-service-account.json')
source_app = firebase_admin.initialize_app(source_cred, name='source')

# Initialize Destination App (New Project)
dest_cred = credentials.Certificate('./new-service-account.json')
dest_app = firebase_admin.initialize_app(dest_cred, name='destination')

# Get Firestore clients for both apps
# Note: If your new DB ID is 'default' (not '(default)'), pass it here
source_db = firestore.client(app=source_app)
dest_db = firestore.client(app=dest_app, database_id="default")

def migrate_collection(collection_path):
    """
    Recursively copies documents and subcollections from source to destination.
    """
    docs = source_db.collection(collection_path).stream()
    
    count = 0
    for doc in docs:
        doc_data = doc.to_dict()
        doc_id = doc.id
        
        # Write the document to the destination project
        dest_db.collection(collection_path).document(doc_id).set(doc_data)
        count += 1
        
        # In Python, we must check for subcollections by listing them from the doc reference
        # This requires one additional API call per document
        doc_ref = source_db.collection(collection_path).document(doc_id)
        subcollections = doc_ref.collections()
        
        for sub in subcollections:
            migrate_collection(f"{collection_path}/{doc_id}/{sub.id}")
            
    print(f"Migrated {count} documents from path: {collection_path}")

# List your root-level collections to migrate
root_collections = ['users', 'site_locations']

if __name__ == "__main__":
    try:
        print("Starting Firestore migration...")
        for coll in root_collections:
            migrate_collection(coll)
        print("Migration completed successfully!")
    except Exception as e:
        print(f"Migration failed: {e}")
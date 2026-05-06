import redis
import os
from dotenv import load_dotenv

def migrate():
    load_dotenv()
    
    local_url = "redis://localhost:6379"
    remote_url = os.getenv("REDIS_URL")
    
    if not remote_url or "localhost" in remote_url:
        print("Error: REDIS_URL in .env is missing or still pointing to localhost.")
        return

    print(f"Connecting to local: {local_url}")
    try:
        r_local = redis.from_url(local_url)
        r_local.ping()
    except Exception as e:
        print(f"Failed to connect to local Redis: {e}")
        return

    print(f"Connecting to remote: {remote_url}")
    try:
        r_remote = redis.from_url(remote_url)
        r_remote.ping()
    except Exception as e:
        print(f"Failed to connect to remote Redis: {e}")
        return

    # Get all keys
    keys = r_local.keys('*')
    print(f"Found {len(keys)} keys to migrate...")

    for key in keys:
        try:
            # Get TTL (time to live)
            ttl = r_local.ttl(key)
            if ttl < 0: ttl = 0
            
            # Dump key from local
            value = r_local.dump(key)
            
            # Restore to remote
            r_remote.delete(key) # Clear if exists
            r_remote.restore(key, ttl * 1000 if ttl > 0 else 0, value)
            print(f"  Migrated: {key.decode('utf-8')}")
        except Exception as e:
            print(f"  Error migrating {key}: {e}")

    print("\nMigration complete! Your cloud database is now in sync.")

if __name__ == "__main__":
    migrate()

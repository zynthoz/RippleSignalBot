#!/usr/bin/env python3
"""
Safe cleanup script to reset database and Redis cache to a clean slate.
Preserves schema structure but clears all data.
"""

import os
import sys
import psycopg2
import redis
from dotenv import load_dotenv
from pathlib import Path

# Load environment variables
load_dotenv()

DATABASE_URL = os.getenv('DATABASE_URL', 'postgresql://devkada:devkada_password@localhost:5432/marketpulse')
REDIS_HOST = os.getenv('REDIS_HOST', 'localhost')
REDIS_PORT = int(os.getenv('REDIS_PORT', 6379))
REDIS_DB = int(os.getenv('REDIS_DB', 0))

def clear_postgres():
    """Clear all data from PostgreSQL while preserving schema."""
    try:
        conn = psycopg2.connect(DATABASE_URL)
        cur = conn.cursor()
        
        print("🔄 Clearing PostgreSQL data...")
        
        # Clear all data from tables in correct order (respect foreign keys)
        # Start with dependent tables first
        tables_to_clear = [
            "user_in_app_notifications",  # FK -> signals
            "user_watchlist",              # FK -> users
            "signal_performance",          # FK -> signals
            "signals",                     # FK -> users
            "users",                       # No dependencies
        ]
        
        for table in tables_to_clear:
            try:
                cur.execute(f"DELETE FROM {table};")
                print(f"   ✓ {table}: cleared")
            except psycopg2.Error as e:
                print(f"   ⚠️  {table}: {e}", file=sys.stderr)
        
        # Reset sequences (auto-increment counters) if any exist
        cur.execute("DROP SEQUENCE IF EXISTS signals_id_seq, users_id_seq CASCADE;")
        
        conn.commit()
        print("✅ PostgreSQL database cleared successfully")
        
        cur.close()
        conn.close()
        
    except Exception as e:
        print(f"❌ Error clearing PostgreSQL: {e}", file=sys.stderr)
        raise

def clear_redis():
    """Clear all data from Redis."""
    try:
        print("\n🔄 Clearing Redis cache...")
        
        r = redis.Redis(
            host=REDIS_HOST,
            port=REDIS_PORT,
            db=REDIS_DB,
            decode_responses=True
        )
        
        # Verify connection
        r.ping()
        
        # Get info before clearing
        info = r.info('stats')
        keys_before = r.dbsize()
        
        # Flush the database
        r.flushdb()
        
        keys_after = r.dbsize()
        print(f"✅ Redis cache cleared successfully")
        print(f"   - Keys before: {keys_before}")
        print(f"   - Keys after: {keys_after}")
        
    except Exception as e:
        print(f"❌ Error clearing Redis: {e}", file=sys.stderr)
        raise

def verify_connection():
    """Verify database and Redis connections before clearing."""
    try:
        # Test PostgreSQL
        print("⏳ Verifying PostgreSQL connection...")
        conn = psycopg2.connect(DATABASE_URL)
        conn.close()
        print("✅ PostgreSQL connected")
        
        # Test Redis
        print("⏳ Verifying Redis connection...")
        r = redis.Redis(
            host=REDIS_HOST,
            port=REDIS_PORT,
            db=REDIS_DB,
            decode_responses=True
        )
        r.ping()
        print("✅ Redis connected")
        
        return True
    except Exception as e:
        print(f"❌ Connection verification failed: {e}", file=sys.stderr)
        return False

def main():
    print("=" * 60)
    print("🧹 CLEAN SLATE - Database & Cache Reset")
    print("=" * 60)
    
    # Verify connections first
    if not verify_connection():
        print("\n❌ Cannot proceed without verified connections")
        sys.exit(1)
    
    print("\n⚠️  WARNING: This will delete all data from:")
    print("   - PostgreSQL (signals & users tables)")
    print("   - Redis cache (all keys)")
    print("   - Schema and structure will be preserved")
    
    response = input("\n🤔 Continue? (type 'yes' to proceed): ").strip().lower()
    
    if response != 'yes':
        print("\n❌ Cancelled")
        sys.exit(0)
    
    try:
        clear_postgres()
        clear_redis()
        
        print("\n" + "=" * 60)
        print("✨ Clean slate ready! Database and cache are empty.")
        print("=" * 60)
        print("\n📝 Next steps:")
        print("   1. Start your workers/services")
        print("   2. Ingest new news data")
        print("   3. Fresh signals will be generated")
        
    except Exception as e:
        print(f"\n❌ Cleanup failed: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()

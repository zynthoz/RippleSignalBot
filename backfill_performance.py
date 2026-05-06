#!/usr/bin/env python3
"""
Phase 7: Retroactive Performance Backfill
Backfill performance metrics for all existing signals using the optimized tracker.
"""

import os
import sys
import time
from pathlib import Path
from datetime import datetime, timezone

# Add python directory to path
sys.path.insert(0, str(Path(__file__).parent / 'python'))

from dotenv import load_dotenv
from db_pool import load_environment, initialize_pool
from performance_tracker import track_performance

def main():
    """Run retroactive backfill for all signals."""
    print("=" * 70)
    print("MarketPulse AI - Phase 7: Retroactive Performance Backfill")
    print("=" * 70)
    
    load_environment()
    initialize_pool()
    
    print("\nStarting retroactive backfill...")
    print(f"Timestamp: {datetime.now(timezone.utc).isoformat()}")
    print("This will process all signals from the last 30 days.\n")
    
    start_time = time.time()
    total_records = 0
    batch_num = 0
    
    try:
        # Run performance tracking in batch mode repeatedly until all signals are covered
        while True:
            batch_num += 1
            print(f"\n[BATCH {batch_num}]")
            
            records_in_batch = track_performance()  # None = batch mode (all awaiting signals)
            total_records += records_in_batch
            
            if records_in_batch == 0:
                print("  → No more signals awaiting performance tracking")
                break
            else:
                print(f"  → Recorded {records_in_batch} performance records")
            
            time.sleep(2)  # Small delay between batches
        
        elapsed = time.time() - start_time
        print("\n" + "=" * 70)
        print(f"Backfill complete!")
        print(f"Total records created: {total_records}")
        print(f"Total time: {elapsed:.2f}s")
        print(f"Records/sec: {total_records / elapsed:.1f}")
        print("=" * 70)
        
        return 0
        
    except KeyboardInterrupt:
        print("\n\nBackfill interrupted by user")
        print(f"Partial records created: {total_records}")
        return 1
    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == '__main__':
    sys.exit(main())

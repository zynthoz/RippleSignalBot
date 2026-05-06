"""Performance tracker for signal validation and backfill."""

import os
import time
import json
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
from pathlib import Path

import redis
import psycopg2

from db_pool import initialize_pool, get_connection, return_connection, load_environment
from price_fetcher import fetch_batch_prices, get_cache_stats
from ticker_cache import clear_expired_cache

# Constants
MATURITY_THRESHOLD_HOURS = 24
BATCH_WINDOW_MINUTES = 5  # Process immature signals every 5 minutes or when reaching 24h age
MAX_BATCH_SIZE = 50  # Batch up to 50 signals per processing round
_PRICE_CACHE_LRU_ENABLED = True


def get_immature_signals_ready(r: redis.Redis) -> list:
    """
    Get signals from immature queue that are ready for processing.
    Returns signals that have aged 24+ hours since publication.
    """
    try:
        now = datetime.now(timezone.utc).timestamp()
        # Get all signals from immature queue with score <= now (aged 24+ hours)
        ready_ids = r.zrangebyscore('signals:immature_queue', 0, now, count=MAX_BATCH_SIZE)
        return [sig_id.decode('utf-8') if isinstance(sig_id, bytes) else sig_id for sig_id in ready_ids]
    except Exception as e:
        print(f'Error fetching immature signals from queue: {e}')
        return []


def remove_from_immature_queue(r: redis.Redis, signal_ids: list) -> None:
    """Remove signals from immature queue after processing."""
    try:
        if signal_ids:
            r.zrem('signals:immature_queue', *signal_ids)
    except Exception as e:
        print(f'Warning: Failed to remove signals from immature queue: {e}')


def fetch_signals_awaiting_performance(conn, limit: int = 300, signal_ids: list = None) -> list:
    """
    Fetch signals that need performance tracking.
    If signal_ids provided, fetch only those signals.
    Otherwise, fetch signals from last 30 days that don't have complete performance records.
    """
    cur = None
    try:
        cur = conn.cursor()
        
        if signal_ids:
            # Fetch specific signals (immature queue)
            placeholders = ','.join(['%s'] * len(signal_ids))
            query = f"""
                SELECT id, tickers, article_published_at, direction, positively_affected, negatively_affected
                FROM signals
                WHERE id IN ({placeholders}) AND article_published_at IS NOT NULL
                ORDER BY article_published_at DESC
            """
            cur.execute(query, signal_ids)
        else:
            # Fetch signals without complete performance records
            query = """
                SELECT DISTINCT s.id, s.tickers, s.article_published_at, s.direction, 
                       s.positively_affected, s.negatively_affected
                FROM signals s
                WHERE s.article_published_at IS NOT NULL
                AND s.article_published_at > NOW() - INTERVAL '30 days'
                AND (
                    -- Signal missing 24-hour check
                    NOT EXISTS (
                        SELECT 1 FROM signal_performance sp 
                        WHERE sp.signal_id = s.id AND sp.check_interval = '24hr'
                    )
                    OR
                    -- Signal missing 1-week check
                    NOT EXISTS (
                        SELECT 1 FROM signal_performance sp 
                        WHERE sp.signal_id = s.id AND sp.check_interval = '1week'
                    )
                    OR
                    -- Signal missing 1-month check
                    NOT EXISTS (
                        SELECT 1 FROM signal_performance sp 
                        WHERE sp.signal_id = s.id AND sp.check_interval = '1month'
                    )
                )
                ORDER BY s.article_published_at DESC
                LIMIT %s
            """
            cur.execute(query, (limit,))
        
        signals = cur.fetchall()
        return signals
    finally:
        if cur:
            cur.close()


def batch_check_existing_performance(conn, signal_id: str, ticker: str, intervals: list) -> dict:
    """
    Check which performance records already exist for a signal-ticker combination.
    Returns {interval: exists_boolean} mapping.
    """
    cur = None
    try:
        cur = conn.cursor()
        placeholders = ','.join(['%s'] * len(intervals))
        query = f"""
            SELECT check_interval FROM signal_performance
            WHERE signal_id = %s AND ticker = %s AND check_interval IN ({placeholders})
        """
        cur.execute(query, [signal_id, ticker] + intervals)
        existing = set(row[0] for row in cur.fetchall())
        return {interval: interval in existing for interval in intervals}
    finally:
        if cur:
            cur.close()


def calculate_performance_for_ticker(
    conn, signal_id: str, ticker: str, 
    published_date_str: str, direction: str,
    pos_list: list, neg_list: list
) -> dict:
    """
    Calculate returns for a ticker across all check intervals.
    Returns dict with performance records ready for insertion.
    """
    results = {}
    intervals = [
        ('24hr', timedelta(days=1)),
        ('1week', timedelta(days=7)),
        ('1month', timedelta(days=30)),
    ]
    
    try:
        published_date = datetime.fromisoformat(published_date_str).date()
    except Exception:
        return results
    
    now = datetime.now(timezone.utc)
    
    # Check which intervals are already recorded
    existing = batch_check_existing_performance(conn, signal_id, ticker, [i[0] for i in intervals])
    
    # Fetch prices for all needed dates in one batch call
    all_dates = [published_date_str]
    for interval_name, delta in intervals:
        if not existing[interval_name]:
            check_date = datetime.fromisoformat(published_date_str.replace('Z', '+00:00')) + delta
            all_dates.append(check_date.date().isoformat())
    
    price_data = fetch_batch_prices([ticker], published_date_str)
    entry_data = price_data.get(ticker)
    
    if not entry_data:
        print(f"    [perf] ⚠ {ticker}: No entry price data")
        return results
    
    entry_price = float(entry_data['open'])
    if entry_price == 0:
        return results
    
    print(f"    [perf] {ticker}: Entry ${entry_price:.2f}")
    
    # Now fetch check prices
    for interval_name, delta in intervals:
        if existing[interval_name]:
            continue  # Skip if already recorded
        
        check_datetime = datetime.fromisoformat(published_date_str.replace('Z', '+00:00')) + delta
        check_date_str = check_datetime.date().isoformat()
        
        # Skip if check date is in the future
        if check_datetime > now:
            continue
        
        # Fetch check price
        check_price_data = fetch_batch_prices([ticker], check_date_str).get(ticker)
        if not check_price_data:
            print(f"      [perf] {interval_name}: No price data")
            continue
        
        check_price = float(check_price_data['close'])
        return_pct = ((check_price - entry_price) / entry_price) * 100
        
        # Determine direction correctness
        direction_correct = None
        if direction == 'BULLISH':
            direction_correct = return_pct > 0
        elif direction == 'BEARISH':
            direction_correct = return_pct < 0
        
        if direction in ['MIXED', 'NEUTRAL']:
            if pos_list and ticker in pos_list:
                direction_correct = return_pct > 0
            elif neg_list and ticker in neg_list:
                direction_correct = return_pct < 0
        
        correct_str = "✓" if direction_correct else "✗" if direction_correct is not None else "?"
        print(f"      [perf] {interval_name}: ${check_price:.2f} → {return_pct:>7.2f}% {correct_str}")
        
        results[interval_name] = {
            'entry_price': entry_price,
            'check_price': check_price,
            'return_pct': return_pct,
            'direction_correct': direction_correct,
        }
    
    return results


def batch_insert_performance_records(conn, records: list) -> int:
    """
    Batch insert performance records using ON CONFLICT to avoid duplicates.
    Returns count of inserted records.
    """
    if not records:
        return 0
    
    cur = None
    try:
        cur = conn.cursor()
        inserted_count = 0
        
        for record in records:
            try:
                cur.execute(
                    '''
                    INSERT INTO signal_performance 
                    (signal_id, ticker, check_interval, entry_price, check_price, return_pct, direction_correct)
                    VALUES (%(signal_id)s, %(ticker)s, %(check_interval)s, 
                            %(entry_price)s, %(check_price)s, %(return_pct)s, %(direction_correct)s)
                    ON CONFLICT (signal_id, ticker, check_interval) DO NOTHING
                    ''',
                    record
                )
                if cur.rowcount > 0:
                    inserted_count += 1
            except Exception as e:
                print(f"Warning: Failed to insert performance record for {record.get('signal_id')}: {e}")
        
        conn.commit()
        return inserted_count
    finally:
        if cur:
            cur.close()


def track_performance(signal_id: str = None) -> int:
    """
    Track performance for signals.
    If signal_id provided, track only that signal (synchronous mode).
    Otherwise, process batch of signals awaiting performance data.
    Returns count of records created.
    """
    conn = None
    r = redis.from_url(os.getenv('REDIS_URL'))
    
    try:
        conn = get_connection()
        
        if signal_id:
            # Synchronous mode: track specific signal
            print(f"  [perf] Tracking signal {signal_id} (synchronous mode)")
            signals = fetch_signals_awaiting_performance(conn, signal_ids=[signal_id])
            if not signals:
                print(f"  [perf] ⚠ Signal {signal_id} not found in database")
                return 0
            print(f"  [perf] Found signal, fetching performance data...")
        else:
            # Batch mode: fetch from immature queue and general backfill
            immature_signal_ids = get_immature_signals_ready(r)
            
            if immature_signal_ids:
                # Process ready immature signals
                signals = fetch_signals_awaiting_performance(conn, signal_ids=immature_signal_ids)
            else:
                # Backfill: fetch signals from last 30 days without complete records
                signals = fetch_signals_awaiting_performance(conn)
        
        if not signals:
            return 0
        
        # Common non-ticker words
        blacklist = {'CNBC', 'WSJ', 'BBC', 'ABC', 'CBS', 'CEO', 'USA', 'UK', 'AI', 'NEW', 'APP', 'THE', 'AND', 'FOR', 'OPEC'}
        
        performance_records = []
        immature_processed = []
        
        for sig_data in signals:
            sig_id, raw_tickers, published_at, direction, pos_list, neg_list = sig_data
            
            if not raw_tickers:
                continue
            
            # Normalize tickers
            tickers = []
            for t in raw_tickers:
                if isinstance(t, dict):
                    tickers.append(t.get('symbol', ''))
                else:
                    tickers.append(str(t))
            
            tickers = [t.upper() for t in tickers if t and t.upper() not in blacklist]
            if not tickers:
                continue
            
            published_date_str = published_at.isoformat()
            print(f"  [perf] Processing {len(tickers)} tickers for {published_date_str}")
            
            # Calculate performance for each unique ticker
            for ticker_upper in set(tickers):
                ticker_perf = calculate_performance_for_ticker(
                    conn, str(sig_id), ticker_upper, published_date_str,
                    direction, pos_list or [], neg_list or []
                )
                
                for interval_name, perf_data in ticker_perf.items():
                    performance_records.append({
                        'signal_id': str(sig_id),
                        'ticker': ticker_upper,
                        'check_interval': interval_name,
                        'entry_price': perf_data['entry_price'],
                        'check_price': perf_data['check_price'],
                        'return_pct': perf_data['return_pct'],
                        'direction_correct': perf_data['direction_correct'],
                    })
            
            immature_processed.append(str(sig_id))
        
        # Batch insert all records
        inserted = batch_insert_performance_records(conn, performance_records)
        print(f"  [perf] ✓ Inserted {inserted} performance records")
        
        # Remove processed signals from immature queue
        if immature_processed:
            remove_from_immature_queue(r, immature_processed)
        
        return inserted
    
    except Exception as e:
        print(f'  [perf] ✗ Error in track_performance: {e}')
        import traceback
        traceback.print_exc()
        if conn:
            try:
                conn.rollback()
            except:
                pass
        return 0
    finally:
        if conn:
            return_connection(conn)


if __name__ == "__main__":
    load_environment()
    initialize_pool()
    
    print("Performance tracker started (Loop: 60s)...")
    last_batch_time = time.time()
    
    try:
        while True:
            # Process every 60 seconds
            try:
                inserted = track_performance()
                if inserted > 0:
                    print(f"Recorded {inserted} performance records")
                
                # Clear expired cache entries periodically
                if int(time.time()) % 600 < 60:  # Every 10 minutes
                    expired = clear_expired_cache()
                    if expired > 0:
                        print(f"Cleared {expired} expired ticker cache entries")
                
                # Log cache stats every 5 minutes
                if int(time.time()) % 300 < 60:
                    stats = get_cache_stats()
                    print(f"Price cache stats: {stats}")
                    
            except Exception as e:
                print(f"Error in performance tracking loop: {e}")
            
            time.sleep(60)
    
    except KeyboardInterrupt:
        print("Performance tracker stopped") 


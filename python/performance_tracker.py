import os
import time
import psycopg2
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv
from pathlib import Path

# Load price fetcher
from price_fetcher import fetch_historical_price

def load_environment() -> None:
    project_root = Path(__file__).resolve().parents[1]
    load_dotenv(project_root / '.env')

_PRICE_CACHE = {}

def track_performance(signal_id=None):
    DATABASE_URL = os.getenv('DATABASE_URL')
    if not DATABASE_URL:
        print('Missing DATABASE_URL')
        return

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    # Find signals that need tracking.
    if signal_id:
        query = """
            SELECT id, tickers, article_published_at, direction, positively_affected, negatively_affected
            FROM signals
            WHERE id = %s AND article_published_at IS NOT NULL
        """
        cur.execute(query, (signal_id,))
    else:
        # Check a larger batch to catch up
        query = """
            SELECT id, tickers, article_published_at, direction, positively_affected, negatively_affected
            FROM signals
            WHERE article_published_at IS NOT NULL
            AND article_published_at > NOW() - INTERVAL '30 days'
            ORDER BY article_published_at DESC
            LIMIT 300
        """
        cur.execute(query)
        
    signals = cur.fetchall()
    now = datetime.now(timezone.utc)
    
    # Common non-ticker words that often get extracted
    blacklist = {'CNBC', 'WSJ', 'BBC', 'ABC', 'CBS', 'CEO', 'USA', 'UK', 'AI', 'NEW', 'APP', 'THE', 'AND', 'FOR', 'OPEC'}

    for signal in signals:
        sig_id, raw_tickers, published_at, direction, pos_list, neg_list = signal
        if not raw_tickers:
            continue
            
        # Tickers might be a list of strings or a list of dicts depending on the signal version
        tickers = []
        for t in raw_tickers:
            if isinstance(t, dict):
                tickers.append(t.get('symbol', ''))
            else:
                tickers.append(str(t))
        
        tickers = [t.upper() for t in tickers if t and t.upper() not in blacklist]
        if not tickers:
            continue
            
        published_date_str = published_at.date().isoformat()
        intervals = [
            ('24hr', timedelta(days=1)),
            ('1week', timedelta(days=7)),
            ('1month', timedelta(days=30))
        ]
        
        for ticker_upper in set(tickers): # Use set to avoid duplicates
            for interval_name, delta in intervals:
                check_date = published_at + delta
                if now < check_date:
                    continue
                    
                check_date_str = check_date.date().isoformat()
                
                # Check if we already have this performance record
                cur.execute(
                    "SELECT 1 FROM signal_performance WHERE signal_id = %s AND ticker = %s AND check_interval = %s",
                    (sig_id, ticker_upper, interval_name)
                )
                if cur.fetchone():
                    continue
                    
                # Cache keys
                entry_cache_key = f"{ticker_upper}:{published_date_str}"
                check_cache_key = f"{ticker_upper}:{check_date_str}"
                
                # Fetch entry price
                if entry_cache_key in _PRICE_CACHE:
                    entry_data = _PRICE_CACHE[entry_cache_key]
                else:
                    entry_data = fetch_historical_price(ticker_upper, published_date_str)
                    if entry_data:
                        _PRICE_CACHE[entry_cache_key] = entry_data
                    time.sleep(0.5) # Minimal throttle
                
                # Fetch check price
                if check_cache_key in _PRICE_CACHE:
                    check_data = _PRICE_CACHE[check_cache_key]
                else:
                    check_data = fetch_historical_price(ticker_upper, check_date_str)
                    if check_data:
                        _PRICE_CACHE[check_cache_key] = check_data
                    time.sleep(0.5) # Minimal throttle
                
                if not entry_data or not check_data:
                    continue
                    
                entry_price = float(entry_data['open'])
                check_price = float(check_data['close'])
                
                if entry_price == 0:
                    continue
                    
                return_pct = ((check_price - entry_price) / entry_price) * 100
                
                # direction_correct logic
                direction_correct = None
                if direction == 'BULLISH':
                    direction_correct = return_pct > 0
                elif direction == 'BEARISH':
                    direction_correct = return_pct < 0
                
                if direction in ['MIXED', 'NEUTRAL']:
                    if pos_list and ticker_upper in pos_list:
                        direction_correct = return_pct > 0
                    elif neg_list and ticker_upper in neg_list:
                        direction_correct = return_pct < 0

                try:
                    cur.execute(
                        '''
                        INSERT INTO signal_performance 
                        (signal_id, ticker, check_interval, entry_price, check_price, return_pct, direction_correct)
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (signal_id, ticker, check_interval) DO NOTHING
                        ''',
                        (sig_id, ticker_upper, interval_name, entry_price, check_price, return_pct, direction_correct)
                    )
                    conn.commit()
                    print(f"Recorded {interval_name} performance for {ticker_upper} on signal {sig_id}")
                except Exception as e:
                    print(f"Failed to record performance: {e}")
                    conn.rollback()

    cur.close()
    conn.close()

if __name__ == "__main__":
    load_environment()
    print("Performance tracker started (Loop: 60s)...")
    while True:
        try:
            track_performance()
        except Exception as e:
            print(f"Error tracking performance: {e}")
        # Clear cache every hour to prevent memory bloat and handle stale data (though historical prices shouldn't change)
        if int(time.time()) % 3600 < 60:
            _PRICE_CACHE.clear()
        time.sleep(60) 


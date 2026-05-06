import yfinance as yf
import pandas as pd
from datetime import datetime, timedelta

# Cache for historical prices (ticker:YYYY-MM-DD -> {date, open, close, high, low})
_PRICE_CACHE = {}
_CACHE_MAX_SIZE = 2000
_CACHE_HITS = 0
_CACHE_MISSES = 0


def fetch_historical_price(symbol: str, target_date_str: str) -> dict:
    """
    Fetch historical prices for a given symbol and date.
    Finds the closest trading day if the date is a weekend or holiday.
    Results are cached to avoid redundant API calls.
    Returns: { 'date': '...', 'open': ..., 'close': ..., 'high': ..., 'low': ... } or None
    """
    global _CACHE_HITS, _CACHE_MISSES
    
    if not symbol or not target_date_str:
        return None
        
    try:
        # Try parsing target date
        target_date = datetime.fromisoformat(target_date_str.replace('Z', '+00:00')).date()
    except Exception:
        return None

    # Check cache first
    cache_key = f"{symbol}:{target_date.isoformat()}"
    if cache_key in _PRICE_CACHE:
        _CACHE_HITS += 1
        return _PRICE_CACHE[cache_key]

    # We fetch a window of 5 days around the target date to ensure we hit a trading day
    # yfinance end date is exclusive.
    start_date = target_date - timedelta(days=2)
    end_date = target_date + timedelta(days=5)

    try:
        ticker = yf.Ticker(symbol)
        df = ticker.history(start=start_date.isoformat(), end=end_date.isoformat())
        if df.empty:
            _PRICE_CACHE[cache_key] = None
            _CACHE_MISSES += 1
            return None
            
        # Find the row closest to our target date, but strictly >= target_date
        df.index = df.index.date
        df_after = df[df.index >= target_date]
        
        if df_after.empty:
            # If no days after, just take the last available
            target_row = df.iloc[-1]
            actual_date = df.index[-1]
        else:
            target_row = df_after.iloc[0]
            actual_date = df_after.index[0]
            
        # Extract scalar values
        try:
            result = {
                'date': actual_date.isoformat(),
                'open': float(target_row['Open']),
                'close': float(target_row['Close']),
                'high': float(target_row['High']),
                'low': float(target_row['Low']),
            }
        except (TypeError, ValueError) as e:
            print(f"Error extracting price values for {symbol}: {e}")
            _PRICE_CACHE[cache_key] = None
            _CACHE_MISSES += 1
            return None
        
        # Cache the result
        if len(_PRICE_CACHE) >= _CACHE_MAX_SIZE:
            # Simple eviction: remove oldest entries when cache is full
            oldest_keys = sorted(_PRICE_CACHE.keys())[:_CACHE_MAX_SIZE // 10]
            for k in oldest_keys:
                del _PRICE_CACHE[k]
        
        _PRICE_CACHE[cache_key] = result
        _CACHE_MISSES += 1
        return result
    except Exception as e:
        print(f"Error fetching price for {symbol} on {target_date}: {e}")
        _PRICE_CACHE[cache_key] = None
        _CACHE_MISSES += 1
        return None


def fetch_batch_prices(symbols: list, target_date_str: str) -> dict:
    """
    Fetch historical prices for multiple symbols on the same date.
    More efficient than individual calls as yfinance can batch requests.
    Returns: { symbol: {date, open, close, high, low} or None, ... }
    """
    if not symbols or not target_date_str:
        return {}
    
    try:
        target_date = datetime.fromisoformat(target_date_str.replace('Z', '+00:00')).date()
    except Exception:
        return {}
    
    # Check cache first for all symbols
    results = {}
    uncached_symbols = []
    
    for symbol in symbols:
        cache_key = f"{symbol}:{target_date.isoformat()}"
        if cache_key in _PRICE_CACHE:
            results[symbol] = _PRICE_CACHE[cache_key]
        else:
            uncached_symbols.append(symbol)
    
    if not uncached_symbols:
        return results  # All cached
    
    # Fetch uncached symbols in batch
    start_date = target_date - timedelta(days=2)
    end_date = target_date + timedelta(days=5)
    
    try:
        df_dict = yf.download(
            uncached_symbols,
            start=start_date.isoformat(),
            end=end_date.isoformat(),
            progress=False,
        )
        
        # yfinance returns MultiIndex columns for all downloads (even single ticker)
        # Format: (OHLCV, Ticker) across rows
        
        # Process each symbol
        for symbol in uncached_symbols:
            try:
                # Extract columns for this symbol using MultiIndex
                if len(uncached_symbols) == 1:
                    # Single ticker: df_dict is a DataFrame with MultiIndex columns
                    symbol_data = df_dict
                else:
                    # Multiple tickers: select columns where second level = symbol
                    symbol_data = df_dict.loc[:, df_dict.columns.get_level_values(1) == symbol]
                
                if symbol_data.empty:
                    results[symbol] = None
                    continue
                
                # Flatten MultiIndex columns (remove ticker level)
                if isinstance(symbol_data.columns, pd.MultiIndex):
                    symbol_data.columns = symbol_data.columns.droplevel(1)
                
                df = symbol_data.copy()
                df.index = df.index.date
                
                # Find row for target_date
                target_row = None
                actual_date = None
                
                if target_date in df.index:
                    # Use iloc to get first occurrence if multiple rows on same date
                    matches = df[df.index == target_date]
                    if not matches.empty:
                        target_row = matches.iloc[0]
                        actual_date = target_date
                
                if target_row is None:
                    # Find closest date >= target_date
                    future_rows = df[df.index >= target_date]
                    if not future_rows.empty:
                        target_row = future_rows.iloc[0]
                        actual_date = future_rows.index[0]
                    else:
                        # No date after target, use last available
                        target_row = df.iloc[-1]
                        actual_date = df.index[-1]
                
                # Extract scalar values from Series
                try:
                    open_val = float(target_row['Open'])
                    close_val = float(target_row['Close'])
                    high_val = float(target_row['High'])
                    low_val = float(target_row['Low'])
                except (TypeError, ValueError) as e:
                    print(f"    [price] Error extracting values from {symbol}: {e}")
                    print(f"    [price] Row type: {type(target_row)}, value: {target_row}")
                    results[symbol] = None
                    continue
                
                result = {
                    'date': actual_date.isoformat(),
                    'open': open_val,
                    'close': close_val,
                    'high': high_val,
                    'low': low_val,
                }
                results[symbol] = result
                _PRICE_CACHE[f"{symbol}:{target_date.isoformat()}"] = result
                
            except (KeyError, TypeError, ValueError, IndexError) as e:
                print(f"Error parsing price data for {symbol}: {e}")
                results[symbol] = None
    except Exception as e:
        print(f"Error fetching batch prices for {uncached_symbols} on {target_date}: {e}")
        for symbol in uncached_symbols:
            results[symbol] = None
    
    return results


def get_cache_stats():
    """Return cache hit/miss statistics."""
    return {
        'size': len(_PRICE_CACHE),
        'hits': _CACHE_HITS,
        'misses': _CACHE_MISSES,
        'hit_rate': _CACHE_HITS / (_CACHE_HITS + _CACHE_MISSES) if (_CACHE_HITS + _CACHE_MISSES) > 0 else 0,
    }


def clear_cache():
    """Clear price cache."""
    global _CACHE_HITS, _CACHE_MISSES
    _PRICE_CACHE.clear()
    _CACHE_HITS = 0
    _CACHE_MISSES = 0

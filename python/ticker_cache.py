"""Unified ticker verification and caching module."""

import json
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

# Ticker validity cache with TTL
_TICKER_CACHE = {}
_CACHE_TTL = timedelta(hours=24)  # Cache valid for 24 hours


def verify_ticker_exists(symbol: str, timeout_sec: float = 5.0) -> bool:
    """
    Verify ticker existence via live Yahoo Finance quote lookup.
    Results are cached for 24 hours to avoid redundant API calls.
    """
    symbol = (symbol or '').strip().upper()
    if not symbol:
        return False
    
    # Check cache first
    if symbol in _TICKER_CACHE:
        cached_data = _TICKER_CACHE[symbol]
        if cached_data['timestamp'] > datetime.now() - _CACHE_TTL:
            return cached_data['valid']
    
    params = urllib.parse.urlencode({'symbols': symbol})
    url = f'https://query1.finance.yahoo.com/v7/finance/quote?{params}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})

    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            payload = json.loads(resp.read().decode('utf-8', errors='replace'))
        results = payload.get('quoteResponse', {}).get('result', [])
        if not results:
            _TICKER_CACHE[symbol] = {'valid': False, 'timestamp': datetime.now()}
            return False
        row = results[0]
        quote_type = str(row.get('quoteType') or '').upper()
        market_price = row.get('regularMarketPrice')
        ok = quote_type in {'EQUITY', 'ETF'} and market_price is not None
        _TICKER_CACHE[symbol] = {'valid': ok, 'timestamp': datetime.now()}
        return ok
    except Exception:
        # Fallback: search endpoint usually works without auth
        try:
            search_params = urllib.parse.urlencode({'q': symbol})
            search_url = f'https://query1.finance.yahoo.com/v1/finance/search?{search_params}'
            search_req = urllib.request.Request(search_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(search_req, timeout=timeout_sec) as resp:
                payload = json.loads(resp.read().decode('utf-8', errors='replace'))

            quotes = payload.get('quotes', [])
            exact = None
            for q in quotes:
                if str(q.get('symbol', '')).upper() == symbol:
                    exact = q
                    break

            if not exact:
                _TICKER_CACHE[symbol] = {'valid': False, 'timestamp': datetime.now()}
                return False

            qt = str(exact.get('quoteType', '')).upper()
            ok = qt in {'EQUITY', 'ETF'}
            _TICKER_CACHE[symbol] = {'valid': ok, 'timestamp': datetime.now()}
            return ok
        except Exception:
            _TICKER_CACHE[symbol] = {'valid': False, 'timestamp': datetime.now()}
            return False


def verify_tickers_exist(tickers):
    """
    Accept list of dicts or simple symbols; return list of verified symbol strings.
    Uses shared cache to avoid duplicate verification.
    """
    unique = []
    seen = set()
    for t in tickers or []:
        if isinstance(t, dict):
            s = str(t.get('symbol', '')).upper().strip()
        else:
            s = str(t).upper().strip()
        if not s or s in seen:
            continue
        seen.add(s)
        if verify_ticker_exists(s):
            unique.append(s)
    return unique


def get_cache():
    """Return current cache state (for debugging)."""
    return {k: v['valid'] for k, v in _TICKER_CACHE.items()}


def clear_expired_cache():
    """Remove expired cache entries."""
    cutoff = datetime.now() - _CACHE_TTL
    expired = [k for k, v in _TICKER_CACHE.items() if v['timestamp'] < cutoff]
    for k in expired:
        del _TICKER_CACHE[k]
    return len(expired)

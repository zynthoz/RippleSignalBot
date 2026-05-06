import yfinance as yf
from datetime import datetime, timedelta

def fetch_historical_price(symbol: str, target_date_str: str) -> dict:
    """
    Fetch historical prices for a given symbol and date.
    Finds the closest trading day if the date is a weekend or holiday.
    Returns: { 'date': '...', 'open': ..., 'close': ..., 'high': ..., 'low': ... } or None
    """
    if not symbol or not target_date_str:
        return None
        
    try:
        # Try parsing target date
        target_date = datetime.fromisoformat(target_date_str.replace('Z', '+00:00')).date()
    except Exception:
        return None

    # We fetch a window of 5 days around the target date to ensure we hit a trading day
    # yfinance end date is exclusive.
    start_date = target_date - timedelta(days=2)
    end_date = target_date + timedelta(days=5)

    try:
        ticker = yf.Ticker(symbol)
        df = ticker.history(start=start_date.isoformat(), end=end_date.isoformat())
        if df.empty:
            return None
            
        # Find the row closest to our target date, but strictly >= target_date
        # meaning the next available trading session on or after the target_date
        # (Alternatively, could just take the first row >= target_date)
        df.index = df.index.date
        df_after = df[df.index >= target_date]
        
        if df_after.empty:
            # If no days after, just take the last available
            target_row = df.iloc[-1]
            actual_date = df.index[-1]
        else:
            target_row = df_after.iloc[0]
            actual_date = df_after.index[0]
            
        return {
            'date': actual_date.isoformat(),
            'open': float(target_row['Open']),
            'close': float(target_row['Close']),
            'high': float(target_row['High']),
            'low': float(target_row['Low']),
        }
    except Exception as e:
        print(f"Error fetching price for {symbol} on {target_date}: {e}")
        return None

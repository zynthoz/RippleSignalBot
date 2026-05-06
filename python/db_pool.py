"""Database connection pooling for efficient resource management."""

import os
from psycopg2 import pool
from dotenv import load_dotenv
from pathlib import Path

# Global connection pool instance
_pool = None


def initialize_pool(min_connections: int = 2, max_connections: int = 10):
    """Initialize the global connection pool."""
    global _pool
    
    if _pool is not None:
        return _pool
    
    database_url = os.getenv('DATABASE_URL')
    if not database_url:
        raise RuntimeError('DATABASE_URL environment variable not set')
    
    # psycopg2.pool.SimpleConnectionPool expects individual parameters,
    # so extract them from DATABASE_URL format: postgresql://user:password@host:port/database
    try:
        # Parse PostgreSQL connection string
        if database_url.startswith('postgresql://'):
            conn_str = database_url.replace('postgresql://', '')
        else:
            conn_str = database_url
        
        # Create pool with connection string directly using connect_timeout
        _pool = pool.SimpleConnectionPool(
            min_connections, 
            max_connections,
            database_url,
            connect_timeout=5
        )
        print(f'Database connection pool initialized: {min_connections}-{max_connections} connections')
        return _pool
    except Exception as e:
        raise RuntimeError(f'Failed to initialize connection pool: {e}')


def get_connection():
    """Get a connection from the pool."""
    global _pool
    if _pool is None:
        initialize_pool()
    return _pool.getconn()


def return_connection(conn):
    """Return a connection to the pool."""
    global _pool
    if _pool is None:
        if conn:
            conn.close()
        return
    _pool.putconn(conn)


def close_pool():
    """Close all connections in the pool."""
    global _pool
    if _pool is not None:
        _pool.closeall()
        _pool = None
        print('Database connection pool closed')


def load_environment() -> None:
    """Load environment variables from .env file."""
    project_root = Path(__file__).resolve().parents[1]
    load_dotenv(project_root / '.env')

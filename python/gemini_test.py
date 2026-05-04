#!/usr/bin/env python3

import os
from pathlib import Path
from dotenv import load_dotenv

project_root = Path(__file__).resolve().parents[1]
load_dotenv(project_root / '.env')

from worker import generate_signal_with_gemini

article = {
    'title': 'TSLA surges after record deliveries and beats earnings estimates',
    'description': 'Tesla (TSLA) reported record deliveries and better-than-expected earnings for the quarter, sending the stock higher.',
    'url': 'https://example.com/tesla-earnings',
    'source': 'Example News',
    'publishedAt': '2026-05-04T10:00:00Z'
}

try:
    print('Using model:', os.getenv('GEMINI_MODEL', 'gemini-3.1-flash-lite-preview'))
    result = generate_signal_with_gemini(article)
    print('Gemini response (parsed JSON):')
    print(result)
except Exception as e:
    print('Gemini test failed:', e)

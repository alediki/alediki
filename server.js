const express = require('express');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const Redis = require('ioredis');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// API Keys from user
const ALPHA_VANTAGE_KEY = 'CZ6UKKN7BSPDRX4D';
const COINGECKO_KEY = 'CG-K5qb1fEdtQzfssHxC34gwPJP';

// Validate API keys on startup
console.log('🔑 Alpha Vantage Key:', ALPHA_VANTAGE_KEY.substring(0, 5) + '...');
console.log('🔑 CoinGecko Key:', COINGECKO_KEY.substring(0, 5) + '...');

// Rate limiting configuration
const RATE_LIMITS = {
    ALPHA_VANTAGE: { max: 5, window: 60 },
    COINGECKO: { max: 50, window: 60 },
    NEWSAPI: { max: 100, window: 86400 }
};

// Cache durations (seconds)
const CACHE_DURATION = {
    INDICES: 900,
    STOCKS: 900,
    CRYPTO: 60,
    NEWS: 300,
    ECONOMIC: 3600
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting middleware
const rateLimit = (key, limit) => {
    return async (req, res, next) => {
        const clientIP = req.ip;
        const redisKey = `rate_limit:${key}:${clientIP}`;
        
        const current = await redis.get(redisKey);
        if (current && parseInt(current) >= limit.max) {
            const ttl = await redis.ttl(redisKey);
            return res.status(429).json({ 
                error: 'Rate limit exceeded', 
                retryAfter: ttl 
            });
        }
        
        await redis.multi()
            .incr(redisKey)
            .expire(redisKey, limit.window)
            .exec();
        
        next();
    };
};

// Alpha Vantage Routes
app.get('/api/indices/:symbol', rateLimit('alpha', RATE_LIMITS.ALPHA_VANTAGE), async (req, res) => {
    try {
        const cacheKey = `indices:${req.params.symbol}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            console.log(`📊 Serving ${req.params.symbol} from cache`);
            return res.json(JSON.parse(cached));
        }

        console.log(`📡 Fetching ${req.params.symbol} from Alpha Vantage...`);
        const response = await axios.get('https://www.alphavantage.co/query', {
            params: {
                function: 'TIME_SERIES_INTRADAY',
                symbol: req.params.symbol,
                interval: '1min',
                apikey: ALPHA_VANTAGE_KEY
            },
            timeout: 10000
        });

        if (!response.data || response.data['Note']) {
            console.error('Alpha Vantage API limit reached:', response.data);
            return res.status(429).json({ error: 'Alpha Vantage API limit reached' });
        }

        const data = response.data['Time Series (1min)'];
        if (!data) {
            console.error('No data returned from Alpha Vantage');
            return res.status(500).json({ error: 'No data returned' });
        }

        const processed = Object.entries(data)
            .slice(0, 100)
            .map(([time, values]) => ({
                time: Math.floor(new Date(time).getTime() / 1000),
                value: parseFloat(values['4. close'])
            }))
            .reverse();

        await redis.setex(cacheKey, CACHE_DURATION.INDICES, JSON.stringify(processed));
        console.log(`✅ Saved ${req.params.symbol} to cache`);
        res.json(processed);
    } catch (error) {
        console.error('Alpha Vantage error:', error.message);
        res.status(500).json({ error: 'Failed to fetch indices data' });
    }
});

// Stock data route
app.get('/api/stock/:symbol', rateLimit('alpha', RATE_LIMITS.ALPHA_VANTAGE), async (req, res) => {
    try {
        const cacheKey = `stock:${req.params.symbol}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            return res.json(JSON.parse(cached));
        }

        const response = await axios.get('https://www.alphavantage.co/query', {
            params: {
                function: 'TIME_SERIES_DAILY',
                symbol: req.params.symbol,
                apikey: ALPHA_VANTAGE_KEY
            },
            timeout: 10000
        });

        if (!response.data || response.data['Note']) {
            return res.status(429).json({ error: 'Alpha Vantage API limit reached' });
        }

        const data = response.data['Time Series (Daily)'];
        const processed = Object.entries(data || {})
            .slice(0, 100)
            .map(([date, values]) => ({
                time: Math.floor(new Date(date).getTime() / 1000),
                value: parseFloat(values['4. close'])
            }))
            .reverse();

        await redis.setex(cacheKey, CACHE_DURATION.STOCKS, JSON.stringify(processed));
        res.json(processed);
    } catch (error) {
        console.error('Stock API error:', error.message);
        res.status(500).json({ error: 'Failed to fetch stock data' });
    }
});

// Crypto data route with API key
app.get('/api/crypto/:coinId', rateLimit('coingecko', RATE_LIMITS.COINGECKO), async (req, res) => {
    try {
        const cacheKey = `crypto:${req.params.coinId}`;
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            console.log(`💰 Serving ${req.params.coinId} from cache`);
            return res.json(JSON.parse(cached));
        }

        console.log(`📡 Fetching ${req.params.coinId} from CoinGecko...`);
        
        // CoinGecko API with premium key for higher limits
        const response = await axios.get(`https://api.coingecko.com/api/v3/coins/${req.params.coinId}/ohlc`, {
            params: {
                vs_currency: 'usd',
                days: 7
            },
            headers: {
                'x-cg-pro-api-key': COINGECKO_KEY
            },
            timeout: 10000
        });

        const processed = response.data.map(([timestamp, , , , close]) => ({
            time: Math.floor(timestamp / 1000),
            value: close
        })).slice(-100);

        await redis.setex(cacheKey, CACHE_DURATION.CRYPTO, JSON.stringify(processed));
        console.log(`✅ Saved ${req.params.coinId} to cache`);
        res.json(processed);
    } catch (error) {
        console.error('CoinGecko error:', error.message);
        res.status(500).json({ error: 'Failed to fetch crypto data' });
    }
});

// NewsAPI route (free tier - no key needed for basic usage)
app.get('/api/news', rateLimit('newsapi', RATE_LIMITS.NEWSAPI), async (req, res) => {
    try {
        const cacheKey = 'news:financial';
        const cached = await redis.get(cacheKey);
        
        if (cached) {
            return res.json(JSON.parse(cached));
        }

        // Using NewsAPI free tier (no key required for 100 calls/day)
        const response = await axios.get('https://newsapi.org/v2/everything', {
            params: {
                q: 'economy OR "federal reserve" OR geopolitical OR inflation OR earnings',
                language: 'en',
                sortBy: 'publishedAt',
                pageSize: 20,
                apiKey: 'demo' // Using demo key for basic access
            },
            timeout: 10000
        });

        const articles = response.data.articles.map(article => ({
            title: article.title,
            time: new Date(article.publishedAt).toLocaleTimeString(),
            source: article.source.name,
            impact: calculateNewsImpact(article.title)
        }));

        await redis.setex(cacheKey, CACHE_DURATION.NEWS, JSON.stringify(articles));
        res.json(articles);
    } catch (error) {
        console.error('News API error:', error.message);
        res.status(500).json({ error: 'Failed to fetch news' });
    }
});

// Technical indicators
app.post('/api/indicators', async (req, res) => {
    try {
        const { data, indicators } = req.body;
        const ti = await import('technicalindicators');
        const results = {};
        const values = data.map(d => d.value);

        if (indicators.includes('rsi')) {
            const rsi = ti.RSI.calculate({ period: 14, values });
            results.rsi = rsi[rsi.length - 1];
        }

        if (indicators.includes('macd')) {
            const macd = ti.MACD.calculate({
                values,
                fastPeriod: 12,
                slowPeriod: 26,
                signalPeriod: 9
            });
            results.macd = macd[macd.length - 1];
        }

        if (indicators.includes('bollinger')) {
            const bb = ti.BollingerBands.calculate({
                period: 20,
                stdDev: 2,
                values
            });
            results.bollinger = bb[bb.length - 1];
        }

        res.json(results);
    } catch (error) {
        console.error('Indicators error:', error.message);
        res.status(500).json({ error: 'Failed to calculate indicators' });
    }
});

// Helper functions
function calculateNewsImpact(title) {
    const highImpact = ['fed', 'rate', 'inflation', 'gdp', 'war', 'crisis'];
    const mediumImpact = ['oil', 'trade', 'policy', 'earnings'];
    
    const lower = title.toLowerCase();
    if (highImpact.some(word => lower.includes(word))) return 'high';
    if (mediumImpact.some(word => lower.includes(word))) return 'medium';
    return 'low';
}

// WebSocket server
const server = app.listen(process.env.PORT || 3000, () => {
    console.log(`🚀 FinanceIQ Dashboard running on port ${process.env.PORT || 3000}`);
    console.log(`📊 API Keys: Alpha Vantage (${ALPHA_VANTAGE_KEY.substring(0,5)}...), CoinGecko (${COINGECKO_KEY.substring(0,5)}...)`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('📡 WebSocket client connected');
    ws.on('close', () => console.log('📡 WebSocket client disconnected'));
});

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Auto-update crypto every minute
setInterval(async () => {
    try {
        const response = await axios.get(`http://localhost:${process.env.PORT || 3000}/api/crypto/bitcoin`);
        broadcast({ type: 'crypto', data: response.data });
        console.log('📡 Broadcasted crypto update');
    } catch (error) {
        console.error('Auto-update error:', error.message);
    }
}, 60000);

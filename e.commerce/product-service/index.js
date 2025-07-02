const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');
const app = express();
const port = 3000;

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://ecommerce_user:ecommerce_pass@localhost:5432/ecommerce'
});

// Redis connection
const redisClient = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.connect();

// Middleware
app.use(express.json());

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        // Check database connection
        await pool.query('SELECT 1');
        res.json({ 
            status: 'Product Service is running', 
            database: 'connected',
            timestamp: new Date().toISOString() 
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            database: 'disconnected',
            error: error.message 
        });
    }
});

// Get all products
app.get('/api/products', async (req, res) => {
    try {
        // Try to get from cache first
        const cacheKey = 'products:all';
        const cached = await redisClient.get(cacheKey);
        
        if (cached) {
            return res.json(JSON.parse(cached));
        }

        // Get from database
        const result = await pool.query('SELECT * FROM products WHERE is_active = true ORDER BY created_at DESC');
        const products = result.rows;

        // Cache for 5 minutes
        await redisClient.setEx(cacheKey, 300, JSON.stringify(products));

        res.json(products);
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ error: 'Failed to fetch products' });
    }
});

// Get product by ID
app.get('/api/products/:id', async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        
        if (isNaN(productId)) {
            return res.status(400).json({ error: 'Invalid product ID' });
        }

        const result = await pool.query('SELECT * FROM products WHERE id = $1 AND is_active = true', [productId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching product:', error);
        res.status(500).json({ error: 'Failed to fetch product' });
    }
});

// Get products by category
app.get('/api/products/category/:category', async (req, res) => {
    try {
        const category = req.params.category;
        const result = await pool.query('SELECT * FROM products WHERE category = $1 AND is_active = true ORDER BY created_at DESC', [category]);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching products by category:', error);
        res.status(500).json({ error: 'Failed to fetch products by category' });
    }
});

// Create new product
app.post('/api/products', async (req, res) => {
    try {
        const { name, description, price, category, stock_quantity, sku, image_url } = req.body;
        
        if (!name || !price) {
            return res.status(400).json({ error: 'Name and price are required' });
        }

        const result = await pool.query(
            'INSERT INTO products (name, description, price, category, stock_quantity, sku, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [name, description, price, category, stock_quantity || 0, sku, image_url]
        );

        // Clear cache
        await redisClient.del('products:all');

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating product:', error);
        if (error.code === '23505') { // Unique constraint violation
            res.status(400).json({ error: 'Product SKU already exists' });
        } else {
            res.status(500).json({ error: 'Failed to create product' });
        }
    }
});

// Update product
app.put('/api/products/:id', async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        const { name, description, price, category, stock_quantity, sku, image_url, is_active } = req.body;

        const result = await pool.query(
            'UPDATE products SET name = COALESCE($1, name), description = COALESCE($2, description), price = COALESCE($3, price), category = COALESCE($4, category), stock_quantity = COALESCE($5, stock_quantity), sku = COALESCE($6, sku), image_url = COALESCE($7, image_url), is_active = COALESCE($8, is_active), updated_at = CURRENT_TIMESTAMP WHERE id = $9 RETURNING *',
            [name, description, price, category, stock_quantity, sku, image_url, is_active, productId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        // Clear cache
        await redisClient.del('products:all');

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error updating product:', error);
        res.status(500).json({ error: 'Failed to update product' });
    }
});

// Delete product (soft delete)
app.delete('/api/products/:id', async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        
        const result = await pool.query(
            'UPDATE products SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
            [productId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        // Clear cache
        await redisClient.del('products:all');

        res.json({ message: 'Product deleted successfully' });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ error: 'Failed to delete product' });
    }
});

app.listen(port, () => {
    console.log(`Product Service running on port ${port}`);
    console.log('Available endpoints:');
    console.log('  GET    /health');
    console.log('  GET    /api/products');
    console.log('  GET    /api/products/:id');
    console.log('  GET    /api/products/category/:category');
    console.log('  POST   /api/products');
    console.log('  PUT    /api/products/:id');
    console.log('  DELETE /api/products/:id');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    await pool.end();
    await redisClient.quit();
    process.exit(0);
});
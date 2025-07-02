// order-service/index.js
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3002;

// Database connection
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'ecommerce',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to database:', err.stack);
  } else {
    console.log('Connected to PostgreSQL database');
    release();
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'order-service' });
});

// Get all orders
app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        o.*,
        u.username,
        u.email,
        COUNT(oi.id) as item_count
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.id, u.username, u.email
      ORDER BY o.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get order by ID with items
app.get('/api/orders/:id', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    
    // Get order details
    const orderResult = await pool.query(`
      SELECT 
        o.*,
        u.username,
        u.email,
        u.first_name,
        u.last_name
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      WHERE o.id = $1
    `, [orderId]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Get order items
    const itemsResult = await pool.query(`
      SELECT 
        oi.*,
        p.name as product_name,
        p.description as product_description,
        p.image_url
      FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
    `, [orderId]);

    const order = {
      ...orderResult.rows[0],
      items: itemsResult.rows
    };

    res.json(order);
  } catch (err) {
    console.error('Error fetching order:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get orders by user ID
app.get('/api/users/:userId/orders', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    
    const result = await pool.query(`
      SELECT 
        o.*,
        COUNT(oi.id) as item_count
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      WHERE o.user_id = $1
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `, [userId]);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching user orders:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create new order
app.post('/api/orders', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { 
      user_id, 
      items, 
      shipping_address, 
      billing_address 
    } = req.body;

    // Validate required fields
    if (!user_id || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ 
        error: 'Missing required fields: user_id and items array' 
      });
    }

    // Calculate total amount
    let totalAmount = 0;
    const processedItems = [];

    for (const item of items) {
      // Get product details and check stock
      const productResult = await client.query(
        'SELECT id, name, price, stock_quantity FROM products WHERE id = $1 AND is_active = true',
        [item.product_id]
      );

      if (productResult.rows.length === 0) {
        throw new Error(`Product with ID ${item.product_id} not found or inactive`);
      }

      const product = productResult.rows[0];
      
      if (product.stock_quantity < item.quantity) {
        throw new Error(`Insufficient stock for product ${product.name}. Available: ${product.stock_quantity}, Requested: ${item.quantity}`);
      }

      const itemTotal = parseFloat(product.price) * item.quantity;
      totalAmount += itemTotal;

      processedItems.push({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: product.price,
        total_price: itemTotal
      });

      // Update product stock
      await client.query(
        'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }

    // Create order
    const orderResult = await client.query(`
      INSERT INTO orders (user_id, total_amount, shipping_address, billing_address)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [user_id, totalAmount, shipping_address, billing_address]);

    const order = orderResult.rows[0];

    // Create order items
    for (const item of processedItems) {
      await client.query(`
        INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price)
        VALUES ($1, $2, $3, $4, $5)
      `, [order.id, item.product_id, item.quantity, item.unit_price, item.total_price]);
    }

    await client.query('COMMIT');
    
    // Return the complete order with items
    const completeOrderResult = await pool.query(`
      SELECT 
        o.*,
        u.username,
        u.email
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      WHERE o.id = $1
    `, [order.id]);

    const itemsResult = await pool.query(`
      SELECT 
        oi.*,
        p.name as product_name
      FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE oi.order_id = $1
    `, [order.id]);

    const completeOrder = {
      ...completeOrderResult.rows[0],
      items: itemsResult.rows
    };

    res.status(201).json(completeOrder);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating order:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Update order status
app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: 'Invalid status. Valid statuses: ' + validStatuses.join(', ') 
      });
    }

    const result = await pool.query(`
      UPDATE orders 
      SET status = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
    `, [status, orderId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating order status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cancel order
app.delete('/api/orders/:id', async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const orderId = parseInt(req.params.id);

    // Get order details
    const orderResult = await client.query(
      'SELECT * FROM orders WHERE id = $1',
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    if (order.status === 'delivered') {
      return res.status(400).json({ error: 'Cannot cancel delivered order' });
    }

    // Get order items to restore stock
    const itemsResult = await client.query(
      'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
      [orderId]
    );

    // Restore stock for each item
    for (const item of itemsResult.rows) {
      await client.query(
        'UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2',
        [item.quantity, item.product_id]
      );
    }

    // Update order status to cancelled
    await client.query(
      'UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['cancelled', orderId]
    );

    await client.query('COMMIT');
    
    res.json({ message: 'Order cancelled successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error cancelling order:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Get order statistics
app.get('/api/orders/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_orders,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders,
        COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed_orders,
        COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_orders,
        COUNT(CASE WHEN status = 'shipped' THEN 1 END) as shipped_orders,
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered_orders,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_orders,
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COALESCE(AVG(total_amount), 0) as average_order_value
      FROM orders
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching order statistics:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve static files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Order service running on port ${port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});
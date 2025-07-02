const express = require('express');
const app = express();
const port = 3000;

// Middleware to parse JSON
app.use(express.json());

// Fake product database
const products = {
  1: { id: 1, name: 'Laptop', price: 999.99, category: 'Electronics', stock: 50 },
  2: { id: 2, name: 'Coffee Mug', price: 12.99, category: 'Kitchen', stock: 200 },
  3: { id: 3, name: 'Running Shoes', price: 89.99, category: 'Sports', stock: 30 },
  4: { id: 4, name: 'Book', price: 19.99, category: 'Education', stock: 100 },
  5: { id: 5, name: 'Headphones', price: 149.99, category: 'Electronics', stock: 75 }
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'Product Service is running!', timestamp: new Date().toISOString() });
});

// Get all products
app.get('/api/products', (req, res) => {
  res.json({
    success: true,
    data: Object.values(products),
    count: Object.keys(products).length
  });
});

// Get product by ID
app.get('/api/products/:id', (req, res) => {
  const productId = parseInt(req.params.id);
  const product = products[productId];
  
  if (product) {
    res.json({
      success: true,
      data: product
    });
  } else {
    res.status(404).json({
      success: false,
      error: 'Product not found',
      message: `Product with ID ${productId} does not exist`
    });
  }
});

// Search products by category
app.get('/api/products/category/:category', (req, res) => {
  const category = req.params.category;
  const categoryProducts = Object.values(products).filter(
    product => product.category.toLowerCase() === category.toLowerCase()
  );
  
  if (categoryProducts.length > 0) {
    res.json({
      success: true,
      data: categoryProducts,
      count: categoryProducts.length
    });
  } else {
    res.status(404).json({
      success: false,
      error: 'No products found',
      message: `No products found in category: ${category}`
    });
  }
});

// Add a new product (for testing)
app.post('/api/products', (req, res) => {
  const { name, price, category, stock } = req.body;
  
  if (!name || !price || !category) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields',
      message: 'Name, price, and category are required'
    });
  }
  
  const newId = Math.max(...Object.keys(products).map(Number)) + 1;
  const newProduct = {
    id: newId,
    name,
    price: parseFloat(price),
    category,
    stock: stock || 0
  };
  
  products[newId] = newProduct;
  
  res.status(201).json({
    success: true,
    data: newProduct,
    message: 'Product created successfully'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Product Service API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      products: '/api/products',
      productById: '/api/products/:id',
      productsByCategory: '/api/products/category/:category'
    }
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Product Service running on port ${port}`);
  console.log('Available endpoints:');
  console.log('  GET  /health');
  console.log('  GET  /api/products');
  console.log('  GET  /api/products/:id');
  console.log('  GET  /api/products/category/:category');
  console.log('  POST /api/products');
});

module.exports = app;
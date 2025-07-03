// login-service/index.js
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');  // Changed from 'bcrypt' to 'bcryptjs'
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3001;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Fallback to individual env vars if DATABASE_URL is not set
  user: process.env.DB_USER || process.env.POSTGRES_USER || 'postgres',
  host: process.env.DB_HOST || 'postgres-db',
  database: process.env.DB_NAME || process.env.POSTGRES_DB || 'ecommerce',
  password: process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
});;

// JWT secret (in production, use environment variable)
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-key-change-in-production';

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

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Check if session is still valid
    const sessionResult = await pool.query(
      'SELECT user_id FROM user_sessions WHERE session_token = $1 AND expires_at > NOW()',
      [token]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'login-service' });
});

// User registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, first_name, last_name } = req.body;

    // Validate required fields
    if (!username || !email || !password) {
      return res.status(400).json({ 
        error: 'Missing required fields: username, email, password' 
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate password strength
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    // Check if user already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    // Hash password
    const saltRounds = 12;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Create user
    const result = await pool.query(`
      INSERT INTO users (username, email, password_hash, first_name, last_name)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, username, email, first_name, last_name, created_at
    `, [username, email, password_hash, first_name, last_name]);

    const user = result.rows[0];

    res.status(201).json({
      message: 'User registered successfully',
      user: user
    });
  } catch (err) {
    console.error('Error registering user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username_or_email, password } = req.body;

    if (!username_or_email || !password) {
      return res.status(400).json({ 
        error: 'Missing required fields: username_or_email, password' 
      });
    }

    // Find user by username or email
    const userResult = await pool.query(`
      SELECT id, username, email, password_hash, first_name, last_name, is_active
      FROM users 
      WHERE (username = $1 OR email = $1) AND is_active = true
    `, [username_or_email]);

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT token
    const tokenPayload = {
      user_id: user.id,
      username: user.username,
      email: user.email
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '24h' });

    // Create session record
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // 24 hours from now

    await pool.query(`
      INSERT INTO user_sessions (user_id, session_token, expires_at)
      VALUES ($1, $2, $3)
    `, [user.id, token, expiresAt]);

    // Remove password hash from response
    const { password_hash, ...userWithoutPassword } = user;

    res.json({
      message: 'Login successful',
      token: token,
      user: userWithoutPassword
    });
  } catch (err) {
    console.error('Error during login:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User logout
app.post('/api/auth/logout', authenticateToken, async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    // Delete the session
    await pool.query('DELETE FROM user_sessions WHERE session_token = $1', [token]);

    res.json({ message: 'Logout successful' });
  } catch (err) {
    console.error('Error during logout:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user profile
app.get('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    const userResult = await pool.query(`
      SELECT id, username, email, first_name, last_name, created_at, updated_at
      FROM users 
      WHERE id = $1 AND is_active = true
    `, [req.user.user_id]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(userResult.rows[0]);
  } catch (err) {
    console.error('Error fetching user profile:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user profile
app.put('/api/auth/profile', authenticateToken, async (req, res) => {
  try {
    const { first_name, last_name, email } = req.body;
    const userId = req.user.user_id;

    // Validate email format if provided
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      // Check if email is already taken by another user
      const existingUser = await pool.query(
        'SELECT id FROM users WHERE email = $1 AND id != $2',
        [email, userId]
      );

      if (existingUser.rows.length > 0) {
        return res.status(409).json({ error: 'Email already exists' });
      }
    }

    const result = await pool.query(`
      UPDATE users 
      SET 
        first_name = COALESCE($1, first_name),
        last_name = COALESCE($2, last_name),
        email = COALESCE($3, email),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4 AND is_active = true
      RETURNING id, username, email, first_name, last_name, updated_at
    `, [first_name, last_name, email, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: 'Profile updated successfully',
      user: result.rows[0]
    });
  } catch (err) {
    console.error('Error updating profile:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Change password
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const userId = req.user.user_id;

    if (!current_password || !new_password) {
      return res.status(400).json({ 
        error: 'Missing required fields: current_password, new_password' 
      });
    }

    // Validate new password strength
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    // Get current password hash
    const userResult = await pool.query(
      'SELECT password_hash FROM users WHERE id = $1 AND is_active = true',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const validPassword = await bcrypt.compare(current_password, userResult.rows[0].password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const saltRounds = 12;
    const new_password_hash = await bcrypt.hash(new_password, saltRounds);

    // Update password
    await pool.query(`
      UPDATE users 
      SET password_hash = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [new_password_hash, userId]);

    // Invalidate all existing sessions for this user (force re-login)
    await pool.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);

    res.json({ message: 'Password changed successfully. Please login again.' });
  } catch (err) {
    console.error('Error changing password:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all users (admin endpoint)
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, email, first_name, last_name, created_at, updated_at, is_active
      FROM users 
      ORDER BY created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user by ID
app.get('/api/users/:id', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    
    const result = await pool.query(`
      SELECT id, username, email, first_name, last_name, created_at, updated_at, is_active
      FROM users 
      WHERE id = $1
    `, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Deactivate user account
app.patch('/api/users/:id/deactivate', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    
    const result = await pool.query(`
      UPDATE users 
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, username, email, is_active
    `, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Delete all sessions for this user
    await pool.query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);

    res.json({
      message: 'User account deactivated successfully',
      user: result.rows[0]
    });
  } catch (err) {
    console.error('Error deactivating user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify token endpoint (for other services)
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Check if session is still valid
    const sessionResult = await pool.query(
      'SELECT user_id FROM user_sessions WHERE session_token = $1 AND expires_at > NOW()',
      [token]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    res.json({ 
      valid: true, 
      user: decoded 
    });
  } catch (err) {
    res.status(401).json({ 
      valid: false, 
      error: 'Invalid token' 
    });
  }
});

// Clean up expired sessions (run periodically)
app.post('/api/auth/cleanup-sessions', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM user_sessions WHERE expires_at <= NOW()');
    
    res.json({ 
      message: `Cleaned up ${result.rowCount} expired sessions` 
    });
  } catch (err) {
    console.error('Error cleaning up sessions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user statistics
app.get('/api/users/stats', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_users,
        COUNT(CASE WHEN is_active = true THEN 1 END) as active_users,
        COUNT(CASE WHEN is_active = false THEN 1 END) as inactive_users,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as new_users_last_30_days
      FROM users
    `);

    const sessionStats = await pool.query(`
      SELECT COUNT(*) as active_sessions
      FROM user_sessions
      WHERE expires_at > NOW()
    `);

    res.json({
      ...result.rows[0],
      active_sessions: parseInt(sessionStats.rows[0].active_sessions)
    });
  } catch (err) {
    console.error('Error fetching user statistics:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve static files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Login service running on port ${port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});
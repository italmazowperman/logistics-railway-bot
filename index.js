require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }
});

// Простой эндпоинт для теста
app.post('/api/test-sync', async (req, res) => {
  const { orderNumber, clientName, documentNumber } = req.body;
  
  if (!orderNumber || !clientName) {
    return res.status(400).json({ error: 'orderNumber and clientName are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO public.test_orders (order_number, client_name, document_number)
       VALUES ($1, $2, $3)
       ON CONFLICT (order_number) DO UPDATE
       SET client_name = EXCLUDED.client_name,
           document_number = EXCLUDED.document_number
       RETURNING id`,
      [orderNumber, clientName, documentNumber || null]
    );
    
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});

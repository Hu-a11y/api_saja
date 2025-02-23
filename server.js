const express = require('express');
const { Pool } = require('pg');
const NodeCache = require('node-cache');
require('dotenv').config();
const app = express();
const cache = new NodeCache({ stdTTL: 3600 });
const PORT = process.env.PORT || 6000;

// إعداد اتصال PostgreSQL
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'store_db',
  password: process.env.DB_PASS || '1234',
  port: process.env.DB_PORT || 5432,
});

// Middleware مع زيادة حجم الـ payload
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ---------- الروتات ----------

// ---------- Routes للطلبات ----------

// POST إنشاء طلب جديد
app.post('/api/orders', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const { user_id, items } = req.body;
      
      const orderRes = await client.query(
        'INSERT INTO orders (user_id) VALUES ($1) RETURNING *',
        [user_id]
      );
      
      for (const item of items) {
        await client.query(
          `INSERT INTO order_items 
          (order_id, product_id, quantity) -- تأكد من وجود quantity هنا
          VALUES ($1, $2, $3)`,
          [orderRes.rows[0].id, item.product_id, item.quantity]
        );
      }
      
      await client.query('COMMIT');
      res.status(201).json(orderRes.rows[0]);
      
    } catch (err) {
      // ...
    }
  });
  // GET جميع الطلبات مع التفاصيل
  app.get('/api/orders', async (req, res) => {
    try {
      const { rows: orders } = await pool.query(`
        SELECT o.*, 
        json_agg(json_build_object(
          'product_id', oi.product_id,
          'quantity', oi.quantity,
          'price', oi.price
        )) AS items
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        GROUP BY o.id
      `);
      
      res.json(orders);
    } catch (err) {
      handleServerError(res, err);
    }
  });
  
  // GET طلب معين مع التفاصيل
  app.get('/api/orders/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT o.*, 
        json_agg(json_build_object(
          'product_id', oi.product_id,
          'quantity', oi.quantity,
          'price', oi.price
        )) AS items
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        WHERE o.id = $1
        GROUP BY o.id
      `, [req.params.id]);
      
      if (rows.length === 0) {
        return res.status(404).json({ message: 'الطلب غير موجود' });
      }
      
      res.json(rows[0]);
    } catch (err) {
      handleServerError(res, err);
    }
  });

// ------ اقتراحات المنتجات المرتبطة ------
app.get('/api/products/:id/suggestions', async (req, res) => {
    try {
      const { id } = req.params;
      const { rows } = await pool.query(`
        SELECT 
          p.id,
          p.name,
          p.image_url,
          COUNT(*) AS frequency,
          AVG(o2.price) AS avg_price 
        FROM order_items o1
        JOIN order_items o2 ON o1.order_id = o2.order_id
        JOIN products p ON o2.product_id = p.id
        WHERE o1.product_id = $1
          AND o2.product_id != $1
        GROUP BY p.id
        ORDER BY frequency DESC
        LIMIT 5
      `, [id]);
      
      res.json(rows);
    } catch (err) {
      handleServerError(res, err);
    }
});
// ------ العلاقات الأكثر تكرارا ------
app.get('/api/associations', async (req, res) => {
    try {
        const cached = cache.get('associations');
        
        if (cached) {
            return res.json(cached);
        }

        const { rows } = await pool.query(`
            SELECT 
                p1.name AS product1,
                p2.name AS product2,
                pa.frequency
            FROM product_associations pa
            JOIN products p1 ON pa.product1 = p1.id
            JOIN products p2 ON pa.product2 = p2.id
            ORDER BY pa.frequency DESC
            LIMIT 10
        `);

        cache.set('associations', rows);
        res.json(rows);
        
    } catch (err) {
        handleServerError(res, err);
    }
});

// GET جميع المستخدمين
app.get('/api/users', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users');
    res.json(rows);
  } catch (err) {
    handleServerError(res, err);
  }
});

// GET مستخدم بواسطة ID
app.get('/api/users/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }
    
    res.json(rows[0]);
  } catch (err) {
    handleServerError(res, err);
  }
});

// POST إضافة مستخدم جديد
app.post('/api/users', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ message: 'الاسم مطلوب' });
    }

    const { rows } = await pool.query(
      'INSERT INTO users (name) VALUES ($1) RETURNING *',
      [name]
    );
    
    res.status(201).json(rows[0]);
  } catch (err) {
    handleServerError(res, err);
  }
});

// PUT تحديث مستخدم
app.put('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ message: 'الاسم مطلوب' });
    }
    
    const { rows } = await pool.query(
      'UPDATE users SET name = $1 WHERE id = $2 RETURNING *',
      [name, id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }
    
    res.json(rows[0]);
  } catch (err) {
    handleServerError(res, err);
  }
});

// DELETE حذف مستخدم
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    
    if (rowCount === 0) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }
    
    res.status(204).send();
  } catch (err) {
    handleServerError(res, err);
  }
});

// معالجة الأخطاء
const handleServerError = (res, err) => {
  console.error(err);
  res.status(500).json({
    error: 'خطأ في الخادم',
    message: err.message
  });
};

// تشغيل الخادم
// تشغيل الخادم



/////////////////
// ---------- Routes للـ Products ----------

// GET جميع المنتجات
app.get('/api/products', async (req, res) => {
    try {
      const { q } = req.query; // الكلمة المفتاحية للبحث
      
      let query = 'SELECT * FROM products';
      let params = [];
      
      if (q) {
        const searchTerms = q.split(' ').filter(term => term); // تقسيم الكلمات المفتاحية
        const conditions = searchTerms.map((term, index) => 
          `(name ILIKE $${index + 1} OR description ILIKE $${index + 1} OR category ILIKE $${index + 1})`
        ).join(' AND ');
        
        query += ` WHERE ${conditions}`;
        params = searchTerms.map(term => `%${term}%`);
      }
      
      const { rows } = await pool.query(query, params);
      res.json(rows);
    } catch (err) {
      handleServerError(res, err);
    }
  });
  
  // POST إضافة منتج جديد
  app.post('/api/products', async (req, res) => {
    try {
      const { name, description, category, price, image_url } = req.body;
      
      if (!name || !category || !price) {
        return res.status(400).json({ message: 'الحقول name, category, price مطلوبة' });
      }
  
      const { rows } = await pool.query(
        `INSERT INTO products (name, description, category, price, image_url)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [name, description, category, price, image_url]
      );
      
      res.status(201).json(rows[0]);
    } catch (err) {
      handleServerError(res, err);
    }
  });
  
  // PUT تحديث منتج
  app.put('/api/products/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description, category, price, image_url } = req.body;
  
      const { rows } = await pool.query(
        `UPDATE products 
         SET name = $1, description = $2, category = $3, price = $4, image_url = $5 
         WHERE id = $6 RETURNING *`,
        [name, description, category, price, image_url, id]
      );
      
      if (rows.length === 0) {
        return res.status(404).json({ message: 'المنتج غير موجود' });
      }
      
      res.json(rows[0]);
    } catch (err) {
      handleServerError(res, err);
    }
  });
  
  // DELETE حذف منتج
  app.delete('/api/products/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { rowCount } = await pool.query('DELETE FROM products WHERE id = $1', [id]);
      
      if (rowCount === 0) {
        return res.status(404).json({ message: 'المنتج غير موجود' });
      }
      
      res.status(204).send();
    } catch (err) {
      handleServerError(res, err);
    }
  });
  /// get all categories
  // GET جميع الفئات المميزة
app.get('/api/categories', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT DISTINCT(category) FROM products ORDER BY category ASC'
      );
      
      const categories = rows.map(row => row.category);
      res.json(categories);
    } catch (err) {
      handleServerError(res, err);
    }
  });


  ///get product in category 
  app.get('/api/products', async (req, res) => {
    try {
      const { category, q } = req.query;
      let query = 'SELECT * FROM products';
      let params = [];
      let conditions = [];
  
      // فلترة حسب الفئة
      if (category) {
        conditions.push(`category = $${params.length + 1}`);
        params.push(category);
      }
  
      // بحث عام
      if (q) {
        const searchTerms = q.split(' ');
        const searchConditions = searchTerms.map(term => 
          `(name ILIKE $${params.length + 1} OR description ILIKE $${params.length + 1})`
        ).join(' AND ');
        conditions.push(`(${searchConditions})`);
        params.push(...searchTerms.map(term => `%${term}%`));
      }
  
      // بناء الاستعلام النهائي
      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }
  
      const { rows } = await pool.query(query, params);
      res.json(rows);
      
    } catch (err) {
      handleServerError(res, err);
    }
  });


  pool.query('SELECT NOW()', (err) => {
    if (err) {
      console.error('❌ فشل الاتصال بقاعدة البيانات:', err.message);
    } else {
      console.log('✅ تم الاتصال بنجاح مع قاعدة البيانات PostgreSQL');
    }
  });
  app.listen(PORT, () => {
    console.log(`🟢 الخادم يعمل على المنفذ ${PORT}`);
  });
  // اختبار الاتصال مع قاعدة البيانات

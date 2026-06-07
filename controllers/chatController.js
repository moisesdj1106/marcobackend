const db = require('../config/db');
const { logAction } = require('../utils/auditLogger');

/**
 * Endpoint principal de chat: analiza la intención y ejecuta consultas a la BD.
 * Recibe { message, orderItems } en el body.
 */
async function handleChat(req, res, next) {
  try {
    const { message, orderItems } = req.body || {};
    const user = req.user || null; // puede ser null para clientes no autenticados

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Se requiere el campo message en el body.' });
    }

    const text = message.toLowerCase();

    // Intención: listar productos disponibles
    if (text.includes('productos disponibles') || text.includes('listar productos') || text.includes('ver productos')) {
      const q = `SELECT id, name, price, stock, image_url FROM products WHERE stock > 0 ORDER BY id DESC LIMIT 100`;
      const result = await db.query(q);
      return res.json({ type: 'list', title: 'Productos disponibles', items: result.rows });
    }

    // Intención: consultar producto por id o nombre
    if (text.match(/producto\s+\d+/) || text.includes('buscar producto') || text.includes('producto llamado') || text.includes('producto:')) {
      // Extraer posible id
      const idMatch = text.match(/producto\s+(\d+)/);
      if (idMatch) {
        const id = parseInt(idMatch[1], 10);
        const q = `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = $1`;
        const r = await db.query(q, [id]);
        if (r.rows.length === 0) return res.json({ type: 'text', content: 'No encontré ese producto.' });
        return res.json({ type: 'product', product: r.rows[0] });
      }

      // Buscar por nombre
      const nameMatch = message.match(/producto[:\s]+(.+)/i) || message.match(/buscar producto\s+(.+)/i);
      const nameQuery = nameMatch ? nameMatch[1].trim() : null;
      if (nameQuery) {
        const q = `SELECT id, name, price, stock, image_url FROM products WHERE name ILIKE $1 LIMIT 20`;
        const r = await db.query(q, [`%${nameQuery}%`]);
        if (r.rows.length === 0) return res.json({ type: 'text', content: 'No encontré productos con ese nombre.' });
        return res.json({ type: 'list', title: `Resultados para "${nameQuery}"`, items: r.rows });
      }
    }

    // Intención: consultar stock
    if (text.includes('stock') || text.includes('existencia') || text.includes('cantidad disponible')) {
      // intentar extraer id
      const idMatch = text.match(/(producto\s+)?(\d+)/);
      if (idMatch) {
        const id = parseInt(idMatch[2], 10);
        const q = 'SELECT id, name, stock FROM products WHERE id = $1';
        const r = await db.query(q, [id]);
        if (r.rows.length === 0) return res.json({ type: 'text', content: 'Producto no encontrado.' });
        return res.json({ type: 'stock', product: r.rows[0] });
      }
      return res.json({ type: 'text', content: 'Dime el ID del producto para consultar el stock.' });
    }

    // Intención: crear orden (se espera orderItems en body) -> delega a rutas de orden ya existentes
    if (text.includes('crear orden') || text.includes('generar orden') || text.includes('hacer pedido') || text.includes('comprar')) {
      if (!user) return res.json({ type: 'text', content: 'Debes iniciar sesión para crear una orden.' });
      if (!orderItems || !Array.isArray(orderItems) || orderItems.length === 0) {
        return res.json({ type: 'text', content: 'Envíame los productos (orderItems) que quieres comprar: [{ product_id, quantity }].' });
      }
      // Reusar lógica de orderController: crearPaymentIntent (pero aquí haremos una creación simple sin Stripe)
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        let subtotal = 0;
        const checkedItems = [];
        for (const item of orderItems) {
          const pr = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [item.product_id]);
          if (pr.rows.length === 0) throw new Error(`Producto ${item.product_id} no existe.`);
          const product = pr.rows[0];
          if (product.stock < item.quantity) {
            throw new Error(`Stock insuficiente para ${product.name}. Disponible: ${product.stock}`);
          }
          subtotal += parseFloat(product.price) * item.quantity;
          checkedItems.push({ product_id: product.id, quantity: item.quantity, unit_price: parseFloat(product.price) });
        }
        const tax = Number((subtotal * 0.16).toFixed(2));
        const total = Number((subtotal + tax).toFixed(2));
        const insertOrder = `INSERT INTO orders (user_id, status, subtotal, tax_amount, total_amount, billing_name, billing_email, payment_intent_id)
          VALUES ($1, 'completed', $2, $3, $4, $5, $6, $7) RETURNING id`;
        const orderRes = await client.query(insertOrder, [user.id, subtotal, tax, total, user.name || user.email, user.email, `chat_${Date.now()}`]);
        const orderId = orderRes.rows[0].id;
        for (const it of checkedItems) {
          await client.query('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4)', [orderId, it.product_id, it.quantity, it.unit_price]);
          await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2', [it.quantity, it.product_id]);
        }
        await client.query('COMMIT');
        await logAction(user.id, user.email, 'CHAT_CREATED_ORDER', 'orders', orderId, { total });
        return res.json({ type: 'order', message: 'Orden creada exitosamente.', orderId, total });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // Intención: información de la empresa
    if (text.includes('ubicación') || text.includes('dirección') || text.includes('mision') || text.includes('visión') || text.includes('vision') || text.includes('misión')) {
      // Intentar leer tabla company_info
      try {
        const r = await db.query('SELECT key, value FROM company_info');
        if (r.rows.length === 0) throw new Error('Tabla vacía');
        const info = {};
        for (const row of r.rows) info[row.key] = row.value;
        const payload = {};
        if (text.includes('ubicación') || text.includes('dirección')) payload.content = info.location || info.address || 'No hay dirección registrada.';
        else if (text.includes('mision') || text.includes('misión')) payload.content = info.mission || 'No hay misión registrada.';
        else if (text.includes('vision') || text.includes('visión')) payload.content = info.vision || 'No hay visión registrada.';
        else payload.content = info;
        return res.json({ type: 'text', content: payload.content, raw: payload });
      } catch (err) {
        // Sugerir SQL para crear la tabla si no existe
        const sql = `-- Crear tabla company_info (clave/valor)\nCREATE TABLE company_info (\n  key text PRIMARY KEY,\n  value text\n);\n\nINSERT INTO company_info (key, value) VALUES\n('address', 'Dirección de la empresa aquí'),\n('location', 'Ciudad, País'),\n('mission', 'Nuestra misión...'),\n('vision', 'Nuestra visión...');`;
        return res.json({ type: 'text', content: 'No encontré la información de la empresa en la base de datos. Si quieres, crea la tabla con el SQL que te proporciono.', sql });
      }
    }

    // Intención: comandos admin (estadísticas)
    if (text.includes('generado') || text.includes('ventas') || text.includes('cuánto se generó') || text.includes('ingresos') || text.includes('recaudación')) {
      // Solo admin
      if (!user || user.role !== 'admin') return res.status(403).json({ type: 'text', content: 'Comando disponible solo para administradores.' });
      // Hoy
      const todayQ = `SELECT COALESCE(SUM(total_amount),0) AS total, COUNT(*) AS orders_count FROM orders WHERE status='completed' AND created_at::date = CURRENT_DATE`;
      const prevQ = `SELECT COALESCE(SUM(total_amount),0) AS total, COUNT(*) AS orders_count FROM orders WHERE status='completed' AND created_at::date = CURRENT_DATE - INTERVAL '1 day'`;
      const t = await db.query(todayQ);
      const p = await db.query(prevQ);
      const today = t.rows[0];
      const prev = p.rows[0];
      const improvement = prev.total == 0 ? null : Number(((today.total - prev.total) / prev.total * 100).toFixed(2));
      return res.json({ type: 'admin_stats', today: { total: parseFloat(today.total), orders: parseInt(today.orders_count) }, previous: { total: parseFloat(prev.total), orders: parseInt(prev.orders_count) }, improvement });
    }

    // Caso por defecto: responder con ayuda y capacidades disponibles
    return res.json({ type: 'text', content: 'Puedo: listar productos disponibles, buscar producto por ID o nombre, consultar stock, crear orden (si estás logueado), y dar info de la empresa. Escribe por ejemplo: "Productos disponibles" o "Stock producto 123".' });
  } catch (error) {
    next(error);
  }
}

module.exports = { handleChat };

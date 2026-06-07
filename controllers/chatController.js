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
      // intentar extraer nombre
      const nameMatch = message.match(/stock\s+de\s+(.+)/i) || message.match(/stock\s+(.+)/i) || message.match(/existencia\s+de\s+(.+)/i) || message.match(/hay\s+(.+)/i);
      if (nameMatch) {
        const nameQuery = nameMatch[1].trim();
        const q = 'SELECT id, name, stock FROM products WHERE name ILIKE $1 LIMIT 1';
        const r = await db.query(q, [`%${nameQuery}%`]);
        if (r.rows.length === 0) return res.json({ type: 'text', content: 'No encontré productos con ese nombre.' });
        return res.json({ type: 'stock', product: r.rows[0] });
      }
      return res.json({ type: 'text', content: 'Dime el nombre o el ID del producto para consultar el stock.' });
    }

    // Intención: crear orden (se espera orderItems en body o texto natural)
    if (text.includes('crear orden') || text.includes('generar orden') || text.includes('hacer pedido') || text.includes('comprar')) {
      if (!user) return res.json({ type: 'text', content: 'Debes iniciar sesión para crear una orden. Inicia sesión y vuelve a intentarlo.' });

      // Normalizar orderItems: puede venir como [{ product_id, quantity }] o [{ name, quantity }]
      let items = Array.isArray(orderItems) ? orderItems.slice() : [];

      // Si no vienen orderItems estructurados, intentar parsear del texto (ej: "comprar 2 bujía ngk, 1 batería")
      if ((!items || items.length === 0) && (text.includes('comprar') || text.includes('quiero comprar') || text.includes('compraría') )) {
        // Extraer porciones separadas por ',' o ' y '
        const afterComprar = text.split(/comprar|quiero comprar|compraría/)[1] || '';
        const parts = afterComprar.split(/,| y |;|\band\b/).map(p => p.trim()).filter(Boolean);
        for (const part of parts) {
          const idMatch = part.match(/(?:producto|marca|opci[oó]n|item|art[ií]culo)\s*#?\s*(\d+)\b/i);
          if (idMatch) {
            items.push({ product_id: parseInt(idMatch[1], 10), quantity: 1 });
            continue;
          }
          const m = part.match(/(\d+)\s+(.+)/); // e.g. '2 bujía ngk'
          if (m) {
            const q = parseInt(m[1], 10);
            const name = m[2].trim();
            items.push({ name, quantity: q });
            continue;
          }
          // intentar formato 'Bujía NGK x2' o 'Bujía NGK 2'
          const m2 = part.match(/(.+?)\s+x?(\d+)$/);
          if (m2) {
            items.push({ name: m2[1].trim(), quantity: parseInt(m2[2], 10) });
          }
        }
      }

      if (!items || items.length === 0) {
        return res.json({ type: 'text', content: 'Para crear una orden envíame los productos y cantidades. Ejemplos: "Comprar 2 Bujía NGK, 1 Batería Yuasa" o enviar un objeto JSON con `orderItems: [{ name: "Bujía NGK", quantity: 2 }]`.' });
      }

      // Mapear items por nombre a productos reales si no viene product_id
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        let subtotal = 0;
        const checkedItems = [];
        const notFound = [];

        for (const item of items) {
          let product = null;
          if (item.product_id) {
            const pr = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [item.product_id]);
            if (pr.rows.length === 0) {
              notFound.push(item);
              continue;
            }
            product = pr.rows[0];
          } else if (item.name) {
            // Buscar por nombre (mejor coincidencia)
            const pr = await client.query('SELECT * FROM products WHERE name ILIKE $1 ORDER BY stock DESC LIMIT 1 FOR UPDATE', [`%${item.name}%`]);
            if (pr.rows.length === 0) {
              notFound.push(item);
              continue;
            }
            product = pr.rows[0];
          } else {
            notFound.push(item);
            continue;
          }

          const qty = Number(item.quantity) || 1;
          if (product.stock < qty) {
            return res.json({ type: 'text', content: `Stock insuficiente para ${product.name}. Disponible: ${product.stock}, solicitado: ${qty}` });
          }

          subtotal += parseFloat(product.price) * qty;
          checkedItems.push({ product_id: product.id, quantity: qty, unit_price: parseFloat(product.price), name: product.name, stock: product.stock, image_url: product.image_url });
        }

        if (notFound.length > 0) {
          await client.query('ROLLBACK');
          return res.json({ type: 'text', content: `No encontré los siguientes productos: ${notFound.map(i => i.name || i.product_id).join(', ')}. Revisa los nombres o usa el listado de productos disponibles.` });
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
        await logAction(user.id, user.email, 'CHAT_CREATED_ORDER', 'orders', orderId, { total, items: checkedItems.map(i=>({id:i.product_id,name:i.name,qty:i.quantity})) });
        return res.json({ type: 'order', message: 'Orden creada exitosamente.', orderId, total, items: checkedItems });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // Intención: guardar borrador / presupuesto (no afecta stock)
    if (text.includes('borrador') || text.includes('presupuesto') || text.includes('guardar borrador')) {
      if (!user) return res.json({ type: 'text', content: 'Debes iniciar sesión para guardar un borrador.' });
      let items = Array.isArray(orderItems) ? orderItems.slice() : [];
      if ((!items || items.length === 0) && (text.includes('presupuesto') || text.includes('borrador') )) {
        // intentar parsear como en crear orden
        const after = text.split(/presupuesto|borrador/)[1] || '';
        const parts = after.split(/,| y |;|\band\b/).map(p => p.trim()).filter(Boolean);
        for (const part of parts) {
          const idMatch = part.match(/(?:producto|marca|opci[oó]n|item|art[ií]culo)\s*#?\s*(\d+)\b/i);
          if (idMatch) {
            items.push({ product_id: parseInt(idMatch[1], 10), quantity: 1 });
            continue;
          }
          const m = part.match(/(\d+)\s+(.+)/);
          if (m) items.push({ name: m[2].trim(), quantity: parseInt(m[1],10) });
          else {
            const m2 = part.match(/(.+?)\s+x?(\d+)$/);
            if (m2) items.push({ name: m2[1].trim(), quantity: parseInt(m2[2],10) });
          }
        }
      }
      if (!items || items.length === 0) return res.json({ type: 'text', content: 'Envíame los productos para el borrador, ejemplo: "Presupuesto 2 Bujía NGK, 1 Batería"' });
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        let subtotal = 0;
        const checkedItems = [];
        for (const item of items) {
          let product = null;
          if (item.product_id) {
            const pr = await client.query('SELECT * FROM products WHERE id = $1', [item.product_id]);
            if (pr.rows.length === 0) return res.json({ type: 'text', content: `Producto ${item.product_id} no existe.` });
            product = pr.rows[0];
          } else if (item.name) {
            const pr = await client.query('SELECT * FROM products WHERE name ILIKE $1 ORDER BY stock DESC LIMIT 1', [`%${item.name}%`]);
            if (pr.rows.length === 0) return res.json({ type: 'text', content: `No encontré: ${item.name}` });
            product = pr.rows[0];
          }
          const qty = Number(item.quantity) || 1;
          subtotal += parseFloat(product.price) * qty;
          checkedItems.push({ product_id: product.id, quantity: qty, unit_price: parseFloat(product.price), name: product.name });
        }
        const tax = Number((subtotal * 0.16).toFixed(2));
        const total = Number((subtotal + tax).toFixed(2));
        // Insertar orden en estado 'draft'
        const insertOrder = `INSERT INTO orders (user_id, status, subtotal, tax_amount, total_amount, billing_name, billing_email, payment_intent_id) VALUES ($1, 'draft', $2, $3, $4, $5, $6, $7) RETURNING id`;
        const orderRes = await client.query(insertOrder, [user.id, subtotal, tax, total, user.name || user.email, user.email, `draft_${Date.now()}`]);
        const orderId = orderRes.rows[0].id;
        for (const it of checkedItems) {
          await client.query('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4)', [orderId, it.product_id, it.quantity, it.unit_price]);
        }
        await client.query('COMMIT');
        await logAction(user.id, user.email, 'CHAT_SAVED_DRAFT', 'orders', orderId, { total, items: checkedItems });
        return res.json({ type: 'draft', message: 'Borrador guardado con éxito.', orderId, total, items: checkedItems });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // Intención: reservar/apartar carrito (bloquear stock por X horas)
    if (text.includes('reservar') || text.includes('apartar') || text.includes('apartado')) {
      if (!user) return res.json({ type: 'text', content: 'Debes iniciar sesión para apartar productos.' });
      const hoursMatch = text.match(/(\d+)\s*(horas|hrs|h)/);
      const hours = hoursMatch ? parseInt(hoursMatch[1],10) : 2; // por defecto 2 horas
      let items = Array.isArray(orderItems) ? orderItems.slice() : [];
      if ((!items || items.length === 0) && (text.includes('reservar') || text.includes('apartar'))) {
        const after = text.split(/reservar|apartar/)[1] || '';
        const parts = after.split(/,| y |;|\band\b/).map(p => p.trim()).filter(Boolean);
        for (const part of parts) {
          const idMatch = part.match(/(?:producto|marca|opci[oó]n|item|art[ií]culo)\s*#?\s*(\d+)\b/i);
          if (idMatch) {
            items.push({ product_id: parseInt(idMatch[1], 10), quantity: 1 });
            continue;
          }
          const m = part.match(/(\d+)\s+(.+)/);
          if (m) items.push({ name: m[2].trim(), quantity: parseInt(m[1],10) });
          else {
            const m2 = part.match(/(.+?)\s+x?(\d+)$/);
            if (m2) items.push({ name: m2[1].trim(), quantity: parseInt(m2[2],10) });
          }
        }
      }
      if (!items || items.length === 0) return res.json({ type: 'text', content: 'Envíame los productos a reservar. Ej: "Reservar 2 Bujía NGK por 4 horas"' });

      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        // Intentaremos insertar en tabla reservations; si no existe devolveremos SQL sugerido
        const expiresAt = new Date(Date.now() + hours * 3600 * 1000);
        // Mapear productos y validar stock
        const checkedItems = [];
        for (const item of items) {
          let product = null;
          if (item.product_id) {
            const pr = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [item.product_id]);
            if (pr.rows.length === 0) return res.json({ type: 'text', content: `Producto ${item.product_id} no existe.` });
            product = pr.rows[0];
          } else if (item.name) {
            const pr = await client.query('SELECT * FROM products WHERE name ILIKE $1 ORDER BY stock DESC LIMIT 1 FOR UPDATE', [`%${item.name}%`]);
            if (pr.rows.length === 0) return res.json({ type: 'text', content: `No encontré: ${item.name}` });
            product = pr.rows[0];
          }
          const qty = Number(item.quantity) || 1;
          if (product.stock < qty) return res.json({ type: 'text', content: `Stock insuficiente para ${product.name}. Disponible: ${product.stock}` });
          checkedItems.push({ product_id: product.id, quantity: qty, unit_price: parseFloat(product.price), name: product.name, image_url: product.image_url });
        }

        // Crear reservation
        let reservationId;
        try {
          const resInsert = await client.query('INSERT INTO reservations (user_id, status, expires_at) VALUES ($1, $2, $3) RETURNING id', [user.id, 'reserved', expiresAt]);
          reservationId = resInsert.rows[0].id;
        } catch (err) {
          // Tabla reservations no existe -> devolver SQL sugerido
          await client.query('ROLLBACK');
          const sql = `-- Crear tablas para reservas\nCREATE TABLE reservations (\n  id serial PRIMARY KEY,\n  user_id integer REFERENCES users(id),\n  status text,\n  expires_at timestamptz,\n  created_at timestamptz DEFAULT now()\n);\n\nCREATE TABLE reservation_items (\n  id serial PRIMARY KEY,\n  reservation_id integer REFERENCES reservations(id),\n  product_id integer REFERENCES products(id),\n  quantity integer,\n  unit_price numeric\n);`;
          return res.json({ type: 'text', content: 'No encontré soporte para reservas en la base de datos. Aquí tienes el SQL para crear las tablas de reservas:', sql });
        }

        for (const it of checkedItems) {
          await client.query('INSERT INTO reservation_items (reservation_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4)', [reservationId, it.product_id, it.quantity, it.unit_price]);
          // Restar stock para apartar
          const upd = await client.query('UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING stock', [it.quantity, it.product_id]);
          if (upd.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ type: 'text', content: `Error al reservar ${it.name}. Stock insuficiente.` });
          }
        }

        await client.query('COMMIT');
        await logAction(user.id, user.email, 'CHAT_CREATED_RESERVATION', 'reservations', reservationId, { expiresAt, items: checkedItems });
        return res.json({ type: 'reservation', message: `Productos apartados hasta ${expiresAt.toISOString()}`, reservationId, expiresAt, items: checkedItems });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // Intención: historial personal de órdenes
    if (text.includes('mis ordenes') || text.includes('mis órdenes') || text.includes('mis compras') || text.includes('mis pedidos') || text.includes('historial')) {
      if (!user) return res.json({ type: 'text', content: 'Debes iniciar sesión para ver tu historial de órdenes.' });
      const queryWithInvoices = `SELECT o.id, o.status, o.total_amount, o.created_at,
        COALESCE(json_agg(DISTINCT json_build_object('product_id', oi.product_id, 'quantity', oi.quantity, 'unit_price', oi.unit_price, 'product_name', p.name)) FILTER (WHERE oi.id IS NOT NULL), '[]') as items,
        MAX(i.id) as invoice_id
        FROM orders o
        LEFT JOIN order_items oi ON o.id = oi.order_id
        LEFT JOIN products p ON oi.product_id = p.id
        LEFT JOIN invoices i ON i.order_id = o.id
        WHERE o.user_id = $1
        GROUP BY o.id
        ORDER BY o.created_at DESC LIMIT 50`;
      let result;
      try {
        result = await db.query(queryWithInvoices, [user.id]);
      } catch (err) {
        const fallbackQuery = `SELECT o.id, o.status, o.total_amount, o.created_at, COALESCE(json_agg(json_build_object('product_id', oi.product_id, 'quantity', oi.quantity, 'unit_price', oi.unit_price, 'product_name', p.name)) FILTER (WHERE oi.id IS NOT NULL), '[]') as items FROM orders o LEFT JOIN order_items oi ON o.id = oi.order_id LEFT JOIN products p ON oi.product_id = p.id WHERE o.user_id = $1 GROUP BY o.id ORDER BY o.created_at DESC LIMIT 50`;
        result = await db.query(fallbackQuery, [user.id]);
      }
      return res.json({ type: 'my_orders', orders: result.rows });
    }

    // Intención: solicitar factura / nota
    if (text.includes('factura') || text.includes('solicitar factura') || text.includes('nota fiscal')) {
      if (!user) return res.json({ type: 'text', content: 'Debes iniciar sesión para solicitar factura.' });
      // Buscar número de orden en el texto. Soporta 'orden 9', 'ORD-9', 'ord-9' o 'factura 9'
      const idMatch = text.match(/orden\s*#?\s*(\d+)/i) || text.match(/ord[-\s]*#?\s*(\d+)/i) || text.match(/factura\s*#?\s*(\d+)/i);
      const orderId = idMatch ? parseInt(idMatch[1],10) : null;
      if (!orderId) return res.json({ type: 'text', content: 'Indica el ID de la orden para la cual solicitas factura. Ej: "Factura orden 123" o "Factura ORD-123"' });
      // Verificar que la orden existe y pertenece al usuario
      const orderCheck = await db.query('SELECT id FROM orders WHERE id = $1 AND user_id = $2', [orderId, user.id]);
      if (orderCheck.rows.length === 0) return res.json({ type: 'text', content: `No encontré la orden ${orderId}. Verifica el número e inténtalo de nuevo.` });

      // Intentar insertar en tabla invoices si existe; si la tabla no existe, registrar la solicitud en logs y devolver instrucción SQL
      try {
        const insert = await db.query('INSERT INTO invoices (order_id, user_id, requested_at, data) VALUES ($1,$2,now(), $3) RETURNING id', [orderId, user.id, JSON.stringify({ requested_by: user.email })]);
        await logAction(user.id, user.email, 'CHAT_REQUESTED_INVOICE', 'invoices', insert.rows[0].id, { orderId });
        return res.json({ type: 'invoice', message: 'Solicitud de factura registrada. El admin será notificado.', invoiceId: insert.rows[0].id, orderId });
      } catch (err) {
        // Si falla por falta de tabla (relation "invoices" does not exist) o similar, registrar en audit y devolver SQL sugerido junto con confirmación temporal
        const sql = `-- Crear tabla invoices\nCREATE TABLE invoices (\n  id serial PRIMARY KEY,\n  order_id integer REFERENCES orders(id),\n  user_id integer REFERENCES users(id),\n  requested_at timestamptz DEFAULT now(),\n  data jsonb\n);`;
        try {
          await logAction(user.id, user.email, 'CHAT_REQUESTED_INVOICE_NO_TABLE', 'invoices', null, { orderId });
        } catch (e) {
          console.warn('No se pudo escribir log de invoice request', e.message);
        }
        return res.json({ type: 'invoice', message: 'Solicitud registrada (temporal). La tabla de facturas no existe en la base de datos; comunica al admin para crearla.', orderId, sql });
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

    // Caso por defecto: responder con ayuda y capacidades disponibles (más directo y con ejemplos)
    return res.json({
      type: 'text',
      content: 'Te puedo ayudar con tareas de la tienda. Ejemplos rápidos:\n• "Productos disponibles" — lista artículos con stock.\n• "Buscar producto bujía NGK" — busca por nombre.\n• "Stock bujía NGK" — consulta existencia.\n• "Comprar 2 Bujía NGK, 1 Batería Yuasa" — crea una orden (debes estar autenticado).\nResponde con el texto como en los ejemplos; si quieres crear una orden también puedes enviar un JSON con `orderItems: [{ name: "Bujía NGK", quantity: 2 }]`.'
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { handleChat };

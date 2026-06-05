const db = require('../config/db');
const { logAction } = require('../utils/auditLogger');
require('dotenv').config();

const useFakePayments = !process.env.STRIPE_SECRET_KEY || process.env.FAKE_PAYMENTS === 'true';
let stripe;
if (!useFakePayments) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

/**
 * 1. Crear un Intento de Pago (Payment Intent) en Stripe y registrar la orden como 'pending'
 */
async function createPaymentIntent(req, res, next) {
  const client = await db.pool.connect();
  try {
    const { items } = req.body; // Array de { product_id, quantity }
    const userId = req.user.id;
    const username = req.user.email;
    const billingName = req.user.name || username;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'El carrito está vacío o el formato es incorrecto.' });
    }

    await client.query('BEGIN');

    const TAX_RATE = 0.16;
    let subtotal = 0;
    const checkedItems = [];

    // Validar productos, stock y calcular el subtotal de forma segura desde la base de datos
    for (const item of items) {
      const productQuery = 'SELECT * FROM products WHERE id = $1 FOR UPDATE'; // Bloqueo para evitar condiciones de carrera en stock
      const productRes = await client.query(productQuery, [item.product_id]);

      if (productRes.rows.length === 0) {
        throw new Error(`El producto con ID ${item.product_id} no existe.`);
      }

      const product = productRes.rows[0];

      if (product.stock < item.quantity) {
        const error = new Error(`Stock insuficiente para el producto: ${product.name}. Disponible: ${product.stock}, solicitado: ${item.quantity}`);
        error.statusCode = 400;
        throw error;
      }

      const unitPrice = parseFloat(product.price);
      subtotal += unitPrice * item.quantity;

      checkedItems.push({
        product_id: product.id,
        name: product.name,
        quantity: item.quantity,
        unit_price: unitPrice
      });
    }

    const taxAmount = Number((subtotal * TAX_RATE).toFixed(2));
    const totalAmount = Number((subtotal + taxAmount).toFixed(2));

    let paymentIntentId = `fake_payment_${userId}_${Date.now()}`;
    let clientSecret = `test_client_secret_${userId}_${Date.now()}`;

    if (!useFakePayments) {
      // Crear Intento de Pago en Stripe
      // Stripe maneja centavos, multiplicamos por 100.
      const amountInCents = Math.round(totalAmount * 100);
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: 'cop', // Pesos Colombianos.
          metadata: {
            userId: userId.toString(),
            username,
            billingName
          }
        });
        paymentIntentId = paymentIntent.id;
        clientSecret = paymentIntent.client_secret;
      } catch (stripeError) {
        console.warn('⚠️ Stripe no disponible, usando pago simulado:', stripeError.message);
        paymentIntentId = `fake_payment_${Date.now()}`;
        clientSecret = `test_client_secret_${Date.now()}`;
      }
    }

    // Guardar la orden en estado 'pending' en la base de datos
    const insertOrderQuery = `
      INSERT INTO orders (user_id, status, subtotal, tax_amount, total_amount, billing_name, billing_email, payment_intent_id)
      VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7)
      RETURNING id
    `;
    const orderRes = await client.query(insertOrderQuery, [userId, subtotal, taxAmount, totalAmount, billingName, username, paymentIntentId]);
    const orderId = orderRes.rows[0].id;

    // Guardar los detalles de la orden (order_items)
    const insertItemQuery = `
      INSERT INTO order_items (order_id, product_id, quantity, unit_price)
      VALUES ($1, $2, $3, $4)
    `;
    for (const checkedItem of checkedItems) {
      await client.query(insertItemQuery, [orderId, checkedItem.product_id, checkedItem.quantity, checkedItem.unit_price]);
    }
    // Si estamos en modo de pagos simulados, completar la orden inmediatamente:
    if (useFakePayments) {
      // Restar stock para cada item (mismo comportamiento que en confirmPayment)
      const itemsQuery = 'SELECT product_id, quantity FROM order_items WHERE order_id = $1';
      const itemsRes = await client.query(itemsQuery, [orderId]);

      for (const item of itemsRes.rows) {
        const updateStockQuery = `
          UPDATE products
          SET stock = stock - $1
          WHERE id = $2 AND stock >= $1
          RETURNING name, stock
        `;
        const stockRes = await client.query(updateStockQuery, [item.quantity, item.product_id]);
        if (stockRes.rows.length === 0) {
          throw new Error('Error al actualizar inventario en pago simulado. Stock insuficiente.');
        }
      }

      // Marcar orden como completada (verificamos payment_intent_id para seguridad)
      const updateRes = await client.query(
        "UPDATE orders SET status = 'completed' WHERE id = $1 AND payment_intent_id = $2 RETURNING id",
        [orderId, paymentIntentId]
      );
      if (updateRes.rows.length === 0) {
        throw new Error('No se pudo marcar la orden como completada en modo simulado.');
      }

      await client.query('COMMIT');

      // Auditoría
      await logAction(userId, username, 'COMPLETED_PURCHASE', 'orders', orderId, {
        total: totalAmount,
        paymentIntentId,
      });

      return res.status(201).json({
        clientSecret,
        paymentIntentId,
        orderId,
        subtotal,
        taxAmount,
        totalAmount,
        status: 'completed'
      });
    }

    await client.query('COMMIT');

    // Retornar el client_secret y el ID de la orden creada (modo real o fallback)
    return res.status(201).json({
      clientSecret,
      paymentIntentId,
      orderId,
      subtotal,
      taxAmount,
      totalAmount
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
}

/**
 * 2. Confirmar el pago de la orden (después de que el frontend procese la tarjeta con Stripe)
 */
async function confirmPayment(req, res, next) {
  const client = await db.pool.connect();
  try {
    const { orderId, paymentIntentId, success } = req.body;
    const userId = req.user.id;
    const username = req.user.email;

    if (!orderId || !paymentIntentId) {
      return res.status(400).json({ error: 'Faltan datos requeridos (orderId, paymentIntentId).' });
    }

    await client.query('BEGIN');

    // Obtener la orden
    const orderQuery = 'SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE';
    const orderRes = await client.query(orderQuery, [orderId, userId]);

    if (orderRes.rows.length === 0) {
      throw new Error('La orden no existe o no pertenece al usuario autenticado.');
    }

    const order = orderRes.rows[0];

    if (order.status !== 'pending') {
      return res.json({ message: `La orden ya se encuentra en estado: ${order.status}`, status: order.status });
    }

    // Determinar resultado del pago
    let paymentSucceeded = false;
    let failureReason = 'Transacción rechazada por el banco/tarjeta.';

    // Si estamos en modo de pagos simulados, siempre consideramos el pago como exitoso
    if (useFakePayments) {
      paymentSucceeded = true;
    } else if (success) {
      // En modo real: verificar el estado en Stripe
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (paymentIntent.status === 'succeeded') {
          paymentSucceeded = true;
        } else {
          failureReason = `Estado en Stripe: ${paymentIntent.status}. ${paymentIntent.last_payment_error ? paymentIntent.last_payment_error.message : ''}`;
        }
      } catch (stripeErr) {
        console.error('Error verificando PaymentIntent con Stripe:', stripeErr.message);
        failureReason = 'No se pudo verificar el estado en Stripe.';
      }
    } else {
      // El frontend indicó que no hubo éxito (success falsy) y no estamos en modo fake
      failureReason = 'El frontend indicó que la transacción no fue completada.';
    }

    if (paymentSucceeded) {
      // 1. Cambiar estado de orden a 'completed'
      const updateRes = await client.query("UPDATE orders SET status = 'completed' WHERE id = $1 AND payment_intent_id = $2 RETURNING id", [orderId, paymentIntentId]);
      if (updateRes.rows.length === 0) {
        throw new Error('No se pudo marcar la orden como completada. Verifica los identificadores.');
      }

      // 2. Obtener items de la orden para restar el inventario (cascada de stock)
      const itemsQuery = 'SELECT product_id, quantity FROM order_items WHERE order_id = $1';
      const itemsRes = await client.query(itemsQuery, [orderId]);

      for (const item of itemsRes.rows) {
        // Restar stock y validar que no quede negativo (Check constraint en DB reforzado aquí)
        const updateStockQuery = `
          UPDATE products 
          SET stock = stock - $1 
          WHERE id = $2 AND stock >= $1
          RETURNING name, stock
        `;
        const stockRes = await client.query(updateStockQuery, [item.quantity, item.product_id]);
        
        if (stockRes.rows.length === 0) {
          throw new Error('Error al actualizar inventario. Stock insuficiente en el momento de confirmar el pago.');
        }
      }

      await client.query('COMMIT');

      // 3. Registrar auditoría de éxito
      await logAction(userId, username, 'COMPLETED_PURCHASE', 'orders', orderId, {
        total: order.total_amount,
        paymentIntentId
      });

      return res.json({ message: 'Pago verificado y orden completada con éxito.', status: 'completed' });
    } else {
      // Si el pago no fue exitoso:
      // 1. Cambiar estado de la orden a 'rejected' (guardamos la orden rechazada para auditoría e historial)
      const rejRes = await client.query("UPDATE orders SET status = 'rejected' WHERE id = $1 AND payment_intent_id = $2 RETURNING id", [orderId, paymentIntentId]);
      if (rejRes.rows.length === 0) {
        throw new Error('No se pudo marcar la orden como rechazada. Verifica los identificadores.');
      }
      await client.query('COMMIT');

      // 2. Registrar auditoría de transacción rechazada (quien, cuando, que paso)
      await logAction(userId, username, 'REJECTED_PURCHASE', 'orders', orderId, {
        total: order.total_amount,
        reason: failureReason,
        paymentIntentId
      });

      return res.status(400).json({ error: 'La transacción de pago fue rechazada.', reason: failureReason, status: 'rejected' });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
}

/**
 * 3. Obtener el historial de órdenes del cliente logueado
 */
async function getMyOrders(req, res, next) {
  try {
    const userId = req.user.id;
    const query = `
      SELECT o.*, u.name AS user_name, u.email AS user_email,
             COALESCE(json_agg(
               json_build_object(
                 'id', oi.id,
                 'product_id', oi.product_id,
                 'product_name', p.name,
                 'quantity', oi.quantity,
                 'unit_price', oi.unit_price,
                 'image_url', p.image_url
               )
             ) FILTER (WHERE oi.id IS NOT NULL), '[]') as items
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      LEFT JOIN order_items oi ON o.id = oi.order_id
      LEFT JOIN products p ON oi.product_id = p.id
      WHERE o.user_id = $1
      GROUP BY o.id, u.name, u.email
      ORDER BY o.created_at DESC
    `;
    const result = await db.query(query, [userId]);
    return res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

/**
 * 4. Obtener todas las órdenes del sistema (Solo Admin)
 */
async function getAllOrders(req, res, next) {
  try {
    // Soportar filtros: status, customer, date_from, date_to, min_total, max_total
    const { status, customer, date_from, date_to, min_total, max_total, limit } = req.query;
    const params = [];
    const where = [];

    if (status) {
      params.push(status);
      where.push(`o.status = $${params.length}`);
    }
    if (customer) {
      params.push(`%${customer}%`);
      where.push(`(o.billing_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
    }
    if (date_from) {
      params.push(date_from);
      where.push(`o.created_at >= $${params.length}`);
    }
    if (date_to) {
      params.push(date_to);
      where.push(`o.created_at <= $${params.length}`);
    }
    if (min_total) {
      params.push(min_total);
      where.push(`o.total_amount >= $${params.length}`);
    }
    if (max_total) {
      params.push(max_total);
      where.push(`o.total_amount <= $${params.length}`);
    }

    let query = `SELECT o.*, u.name as user_name, u.email as user_email,
                        COALESCE(json_agg(
                          json_build_object(
                            'id', oi.id,
                            'product_id', oi.product_id,
                            'product_name', p.name,
                            'quantity', oi.quantity,
                            'unit_price', oi.unit_price,
                            'image_url', p.image_url
                          )
                        ) FILTER (WHERE oi.id IS NOT NULL), '[]') as items
                 FROM orders o
                 LEFT JOIN users u ON o.user_id = u.id
                 LEFT JOIN order_items oi ON o.id = oi.order_id
                 LEFT JOIN products p ON oi.product_id = p.id`;

    if (where.length > 0) {
      query += ' WHERE ' + where.join(' AND ');
    }

    query += ' GROUP BY o.id, u.name, u.email ORDER BY o.created_at DESC';
    const maxLimit = Math.min( Number(limit) || 1000, 5000 );
    query += ` LIMIT ${maxLimit}`;

    const result = await db.query(query, params);
    return res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  createPaymentIntent,
  confirmPayment,
  getMyOrders,
  getAllOrders,
};

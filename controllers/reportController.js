const db = require('../config/db');

/**
 * Obtener estadísticas globales y reportes agrupados por período (Día, Semana, Mes, Año)
 * para el panel administrativo (Dashboard).
 */
async function getDashboardStats(req, res, next) {
  try {
    // 1. Resumen global (Ganancias totales, órdenes completadas, órdenes rechazadas, productos vendidos, clientes registrados)
    const summaryQuery = `
      SELECT 
        (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE status = 'completed') as total_revenue,
        (SELECT COUNT(*) FROM orders WHERE status = 'completed') as completed_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'rejected') as rejected_orders,
        (SELECT COALESCE(SUM(quantity), 0) FROM order_items oi JOIN orders o ON oi.order_id = o.id WHERE o.status = 'completed') as total_products_sold,
        (SELECT COUNT(*) FROM users WHERE role = 'client') as total_clients
    `;
    const summaryRes = await db.query(summaryQuery);
    const summary = summaryRes.rows[0];

    // Convertir a float
    summary.total_revenue = parseFloat(summary.total_revenue);
    summary.completed_orders = parseInt(summary.completed_orders);
    summary.rejected_orders = parseInt(summary.rejected_orders);
    summary.total_products_sold = parseInt(summary.total_products_sold);
    summary.total_clients = parseInt(summary.total_clients);

    // 2. Ventas por Día (últimos 30 días)
    const salesByDayQuery = `
      SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as period,
             COUNT(id) as total_orders,
             SUM(total_amount) as total_sales
      FROM orders
      WHERE status = 'completed' AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY period
      ORDER BY period ASC
    `;
    const salesByDayRes = await db.query(salesByDayQuery);
    const salesByDay = salesByDayRes.rows.map(row => ({
      period: row.period,
      total_orders: parseInt(row.total_orders),
      total_sales: parseFloat(row.total_sales)
    }));

    // 3. Ventas por Semana (últimas 12 semanas)
    const salesByWeekQuery = `
      SELECT TO_CHAR(DATE_TRUNC('week', created_at), 'YYYY-"W"IW') as period,
             COUNT(id) as total_orders,
             SUM(total_amount) as total_sales
      FROM orders
      WHERE status = 'completed' AND created_at >= NOW() - INTERVAL '12 weeks'
      GROUP BY DATE_TRUNC('week', created_at), period
      ORDER BY DATE_TRUNC('week', created_at) ASC
    `;
    const salesByWeekRes = await db.query(salesByWeekQuery);
    const salesByWeek = salesByWeekRes.rows.map(row => ({
      period: row.period,
      total_orders: parseInt(row.total_orders),
      total_sales: parseFloat(row.total_sales)
    }));

    // 4. Ventas por Mes (últimos 12 meses)
    const salesByMonthQuery = `
      SELECT TO_CHAR(created_at, 'YYYY-MM') as period,
             COUNT(id) as total_orders,
             SUM(total_amount) as total_sales
      FROM orders
      WHERE status = 'completed' AND created_at >= NOW() - INTERVAL '12 months'
      GROUP BY period
      ORDER BY period ASC
    `;
    const salesByMonthRes = await db.query(salesByMonthQuery);
    const salesByMonth = salesByMonthRes.rows.map(row => ({
      period: row.period,
      total_orders: parseInt(row.total_orders),
      total_sales: parseFloat(row.total_sales)
    }));

    // 5. Ventas por Año
    const salesByYearQuery = `
      SELECT TO_CHAR(created_at, 'YYYY') as period,
             COUNT(id) as total_orders,
             SUM(total_amount) as total_sales
      FROM orders
      WHERE status = 'completed'
      GROUP BY period
      ORDER BY period ASC
    `;
    const salesByYearRes = await db.query(salesByYearQuery);
    const salesByYear = salesByYearRes.rows.map(row => ({
      period: row.period,
      total_orders: parseInt(row.total_orders),
      total_sales: parseFloat(row.total_sales)
    }));

    // 6. Top 5 productos más vendidos
    const topProductsQuery = `
      SELECT p.id, p.name, 
             SUM(oi.quantity) as qty_sold, 
             SUM(oi.quantity * oi.unit_price) as revenue
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status = 'completed'
      GROUP BY p.id, p.name
      ORDER BY qty_sold DESC
      LIMIT 5
    `;
    const topProductsRes = await db.query(topProductsQuery);
    const topProducts = topProductsRes.rows.map(row => ({
      id: row.id,
      name: row.name,
      qty_sold: parseInt(row.qty_sold),
      revenue: parseFloat(row.revenue)
    }));

    return res.json({
      summary,
      salesByDay,
      salesByWeek,
      salesByMonth,
      salesByYear,
      topProducts
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDashboardStats,
};

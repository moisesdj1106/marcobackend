const db = require('../config/db');

/**
 * Obtener logs de auditoría (Solo Admin)
 * Retorna los últimos 200 registros de actividad ordenados por fecha descendente.
 */
async function getAuditLogs(req, res, next) {
  try {
    // Soportar filtros opcionales via query params: user, action, entity, date_from, date_to, limit
    const { user, action, entity, date_from, date_to, limit } = req.query;
    const params = [];
    const where = [];

    if (user) {
      params.push(`%${user}%`);
      where.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
    }
    if (action) {
      params.push(action);
      where.push(`a.action = $${params.length}`);
    }
    if (entity) {
      params.push(`%${entity}%`);
      where.push(`a.entity ILIKE $${params.length}`);
    }
    if (date_from) {
      params.push(date_from);
      where.push(`a.created_at >= $${params.length}`);
    }
    if (date_to) {
      params.push(date_to);
      where.push(`a.created_at <= $${params.length}`);
    }

    let query = `SELECT a.*, u.name as user_fullname, u.role as user_role
                 FROM audit_logs a
                 LEFT JOIN users u ON a.user_id = u.id`;

    if (where.length > 0) {
      query += ' WHERE ' + where.join(' AND ');
    }

    const pageNumber = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 10, 1), 50);
    const offset = (pageNumber - 1) * pageSize;

    // Obtener total para paginación
    const countQuery = `SELECT COUNT(*) AS total
                        FROM audit_logs a
                        LEFT JOIN users u ON a.user_id = u.id${where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''}`;
    const countResult = await db.query(countQuery, params);
    const total = Number(countResult.rows[0]?.total || 0);

    query += ' ORDER BY a.created_at DESC';
    query += ` LIMIT ${pageSize} OFFSET ${offset}`;

    const result = await db.query(query, params);
    return res.json({ logs: result.rows, total, page: pageNumber, pageSize });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAuditLogs,
};

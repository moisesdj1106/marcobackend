const db = require('../config/db');

/**
 * Obtener logs de auditoría (Solo Admin)
 * Retorna los últimos 200 registros de actividad ordenados por fecha descendente.
 */
async function getAuditLogs(req, res, next) {
  try {
    const query = `
      SELECT a.*, u.name as user_fullname, u.role as user_role
      FROM audit_logs a
      LEFT JOIN users u ON a.user_id = u.id
      ORDER BY a.created_at DESC
      LIMIT 200
    `;
    const result = await db.query(query);
    return res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAuditLogs,
};

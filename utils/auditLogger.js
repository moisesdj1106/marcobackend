const db = require('../config/db');

/**
 * Registra una acción en la tabla audit_logs
 * @param {number|null} userId - ID del usuario que realiza la acción (puede ser null para acciones no autenticadas como fallos de login)
 * @param {string} username - Nombre o correo del usuario
 * @param {string} action - Tipo de acción (e.g. 'LOGIN', 'CREATE_PRODUCT', 'UPDATE_PRODUCT', 'DELETE_PRODUCT', 'COMPLETED_PURCHASE', 'REJECTED_PURCHASE')
 * @param {string} entity - Tabla afectada (e.g. 'products', 'orders', 'users')
 * @param {number|null} entityId - ID del registro afectado
 * @param {object|null} details - Datos adicionales en formato objeto/JSON
 */
async function logAction(userId, username, action, entity, entityId = null, details = null) {
  try {
    const queryText = `
      INSERT INTO audit_logs (user_id, username, action, entity, entity_id, details)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const values = [
      userId,
      username || 'Desconocido',
      action,
      entity,
      entityId,
      details ? JSON.stringify(details) : null
    ];
    await db.query(queryText, values);
  } catch (error) {
    console.error('❌ Error escribiendo en log de auditoría:', error.message);
  }
}

module.exports = {
  logAction,
};

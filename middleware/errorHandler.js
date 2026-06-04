/**
 * Middleware centralizado de manejo de errores.
 */
function errorHandler(err, req, res, next) {
  console.error('❌ Error capturado:', err.stack || err.message);

  // Errores conocidos de PostgreSQL (por ejemplo, restricciones UNIQUE o de tipo)
  if (err.code && err.code.startsWith('23')) {
    let message = 'Error de integridad en la base de datos.';
    if (err.code === '23505') {
      message = 'Ya existe un registro con este dato único (duplicado).';
    } else if (err.code === '23503') {
      message = 'No se puede realizar la operación debido a una restricción de clave foránea.';
    }
    return res.status(400).json({
      error: message,
      details: err.detail || err.message,
    });
  }

  // Errores de Stripe
  if (err.type && err.type.startsWith('Stripe')) {
    return res.status(err.statusCode || 400).json({
      error: 'Error en la pasarela de pagos (Stripe).',
      details: err.message,
    });
  }

  // Error genérico por defecto
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: err.message || 'Ocurrió un error inesperado en el servidor.',
  });
}

module.exports = errorHandler;

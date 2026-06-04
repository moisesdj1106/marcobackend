const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'motorepuestosla33_jwt_secret_token_2026';

/**
 * Middleware para requerir autenticación general.
 */
function protect(req, res, next) {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ error: 'No autorizado, token ausente.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, name, email, role }
    next();
  } catch (error) {
    console.error('❌ Token JWT no válido:', error.message);
    return res.status(401).json({ error: 'No autorizado, token vencido o inválido.' });
  }
}

/**
 * Middleware para requerir rol de Administrador.
 */
function adminOnly(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    return res.status(403).json({ error: 'Acceso denegado, se requiere perfil de Administrador.' });
  }
}

module.exports = {
  protect,
  adminOnly,
};

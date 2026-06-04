const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { logAction } = require('../utils/auditLogger');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'motorepuestosla33_jwt_secret_token_2026';

// Expiración de token: 30 días
const TOKEN_EXPIRE = '30d';

/**
 * Registro de nuevos clientes
 */
async function register(req, res, next) {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Por favor, completa todos los campos (name, email, password).' });
    }

    // Verificar si el usuario ya existe
    const userExistQuery = 'SELECT id FROM users WHERE email = $1';
    const existResult = await db.query(userExistQuery, [email]);
    if (existResult.rows.length > 0) {
      return res.status(400).json({ error: 'El correo electrónico ya está registrado.' });
    }

    // Encriptar contraseña
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Insertar usuario (rol predeterminado: client)
    const insertQuery = `
      INSERT INTO users (name, email, password_hash, role)
      VALUES ($1, $2, $3, 'client')
      RETURNING id, name, email, role, created_at
    `;
    const result = await db.query(insertQuery, [name, email, passwordHash]);
    const newUser = result.rows[0];

    // Generar token JWT
    const token = jwt.sign(
      { id: newUser.id, name: newUser.name, email: newUser.email, role: newUser.role },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRE }
    );

    // Log de auditoría
    await logAction(newUser.id, newUser.email, 'REGISTER', 'users', newUser.id, { email: newUser.email });

    return res.status(201).json({
      message: 'Usuario registrado con éxito.',
      token,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: newUser.role,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Inicio de sesión
 */
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Por favor, ingresa correo y contraseña.' });
    }

    // Buscar usuario en DB
    const userQuery = 'SELECT * FROM users WHERE email = $1';
    const result = await db.query(userQuery, [email]);

    if (result.rows.length === 0) {
      // Auditoría de intento fallido
      await logAction(null, email, 'LOGIN_FAILED', 'users', null, { reason: 'Email no existe' });
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    const user = result.rows[0];

    // Verificar contraseña
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      // Auditoría de intento fallido
      await logAction(user.id, user.email, 'LOGIN_FAILED', 'users', user.id, { reason: 'Contraseña incorrecta' });
      return res.status(401).json({ error: 'Credenciales inválidas.' });
    }

    // Generar JWT
    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRE }
    );

    // Log de auditoría
    await logAction(user.id, user.email, 'LOGIN', 'users', user.id);

    return res.json({
      message: 'Ingreso exitoso.',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Obtener perfil del usuario autenticado
 */
async function getMe(req, res, next) {
  try {
    const userQuery = 'SELECT id, name, email, role, created_at FROM users WHERE id = $1';
    const result = await db.query(userQuery, [req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    return res.json({ user: result.rows[0] });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  register,
  login,
  getMe,
};

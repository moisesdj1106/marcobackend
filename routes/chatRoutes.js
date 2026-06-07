const express = require('express');
const router = express.Router();
const { handleChat } = require('../controllers/chatController');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const JWT_SECRET = process.env.JWT_SECRET || 'motorepuestosla33_jwt_secret_token_2026';

// Middleware opcional: intenta leer Bearer token, pero no falla si no existe.
function optionalAuth(req, res, next) {
	try {
		let token;
		if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
			token = req.headers.authorization.split(' ')[1];
		}
		if (!token) return next();
		const decoded = jwt.verify(token, JWT_SECRET);
		req.user = decoded;
		return next();
	} catch (err) {
		// No bloqueamos la petición por token inválido: el controlador decidirá si requiere auth
		return next();
	}
}

// Ruta pública con autenticación opcional
router.post('/', optionalAuth, handleChat);

module.exports = router;

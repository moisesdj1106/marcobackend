const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

// Crear intento de pago
router.post('/checkout', protect, orderController.createPaymentIntent);

// Confirmar transacción (Stripe Succeeded/Failed)
router.post('/confirm', protect, orderController.confirmPayment);

// Listar historial de órdenes del cliente logueado
router.get('/my-orders', protect, orderController.getMyOrders);

// Listar todas las órdenes de la tienda (Admin únicamente)
router.get('/all', protect, adminOnly, orderController.getAllOrders);

module.exports = router;

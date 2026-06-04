const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

// Obtener todas las estadísticas agrupadas (Día, Semana, Mes, Año)
router.get('/dashboard-stats', protect, adminOnly, reportController.getDashboardStats);

module.exports = router;

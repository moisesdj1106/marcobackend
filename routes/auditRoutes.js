const express = require('express');
const router = express.Router();
const auditController = require('../controllers/auditController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

// Listar historial de auditoría
router.get('/', protect, adminOnly, auditController.getAuditLogs);

module.exports = router;

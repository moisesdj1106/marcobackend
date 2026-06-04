const express = require('express');
const router = express.Router();
const productController = require('../controllers/productController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

// 1. Rutas de Categorías (se colocan antes de /:id para evitar colisiones)
router.get('/categories', productController.getCategories);
router.post('/categories', protect, adminOnly, productController.createCategory);
router.delete('/categories/:id', protect, adminOnly, productController.deleteCategory);

// 2. Rutas de Productos
router.get('/', productController.getAllProducts);
router.get('/featured', productController.getFeaturedProducts);
router.get('/:id', productController.getProductById);
router.get('/:id/recommendations', productController.getRecommendations);

// Rutas administrativas de productos
router.post('/', protect, adminOnly, productController.createProduct);
router.put('/:id', protect, adminOnly, productController.updateProduct);
router.delete('/:id', protect, adminOnly, productController.deleteProduct);

module.exports = router;

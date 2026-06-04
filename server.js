const express = require('express');
const cors = require('cors');
require('dotenv').config();
const db = require('./config/db');

// Importar Rutas
const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const reportRoutes = require('./routes/reportRoutes');
const auditRoutes = require('./routes/auditRoutes');

// Importar Manejo de Errores
const errorHandler = require('./middleware/errorHandler');

// Inicializar Aplicación
const app = express();
const PORT = process.env.PORT || 4000;

// Middleware globales
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.FRONTEND_URL || 'https://tu-app.netlify.app'
    : 'http://localhost:3000',
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

// Montar Rutas del API
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/audit', auditRoutes);

// Ruta de estado del servidor
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Servidor de MOTOREPUESTOS LA 33 operando con éxito.' });
});

// Ruta de diagnóstico de base de datos
app.get('/api/diagnostic', async (req, res) => {
  try {
    // Probar conexión a la base de datos
    const dbResult = await db.query('SELECT NOW() as current_time');
    
    // Verificar tablas
    const tablesResult = await db.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    // Verificar datos en productos
    const productsResult = await db.query('SELECT COUNT(*) as product_count FROM products');
    
    res.json({
      status: 'ok',
      database: {
        connected: true,
        current_time: dbResult.rows[0].current_time,
        tables: tablesResult.rows.map(row => row.table_name),
        product_count: parseInt(productsResult.rows[0].product_count)
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Middleware centralizado de manejo de errores (Siempre al final)
app.use(errorHandler);

// Iniciar Servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor Express de MOTOREPUESTOS LA 33 corriendo en puerto ${PORT}`);
  console.log(`URL base: http://localhost:${PORT}`);
});

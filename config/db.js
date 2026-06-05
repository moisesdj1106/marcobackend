const { Pool } = require('pg');
require('dotenv').config();

let poolConfig;

if (process.env.DATABASE_URL) {
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
    },
  };
} else {
  poolConfig = {
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'repuestos_la_33',
    password: process.env.DB_PASSWORD || 'postgres',
    port: parseInt(process.env.DB_PORT || '5432'),
  };

  if (process.env.NODE_ENV === 'production' || process.env.DB_SSL === 'true') {
    poolConfig.ssl = {
      rejectUnauthorized: false, // Render y otros servicios cloud requieren esto
      // Para configuraciones más estrictas de SSL:
      // ca: process.env.DB_SSL_CA,
      // key: process.env.DB_SSL_KEY,
      // cert: process.env.DB_SSL_CERT
    };
  }
}

const pool = new Pool(poolConfig);

// Probar conexión
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error(' Error al conectar a PostgreSQL:', err.message);
    console.error('Detalles SSL:', poolConfig.ssl ? 'SSL activado' : 'SSL desactivado');
  } else {
    console.log(' Conexión a PostgreSQL establecida con éxito.');
    console.log('Modo:', process.env.NODE_ENV || 'development');
    console.log('SSL:', poolConfig.ssl ? 'activado' : 'desactivado');
  }
});

// Manejo de errores de conexión
pool.on('error', (err) => {
  console.error('Error inesperado en el pool de conexiones:', err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};

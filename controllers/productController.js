const db = require('../config/db');
const { logAction } = require('../utils/auditLogger');

/**
 * Obtener todos los productos (con filtros opcionales de búsqueda y categoría)
 */
async function getAllProducts(req, res, next) {
  try {
    const { search, categoryId } = req.query;
    
    // Primero probemos una consulta más simple para diagnóstico
    let queryText = 'SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id';
    const params = [];
    
    // Construir condiciones WHERE dinámicamente
    const whereConditions = [];
    
    if (search) {
      params.push(`%${search}%`);
      whereConditions.push(`(p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`);
    }

    if (categoryId) {
      params.push(categoryId);
      whereConditions.push(`p.category_id = $${params.length}`);
    }
    
    // Agregar condiciones WHERE si existen
    if (whereConditions.length > 0) {
      queryText += ' WHERE ' + whereConditions.join(' AND ');
    }
    
    // Agregar ORDER BY
    queryText += ' ORDER BY p.id ASC';

    console.log('SQL Query:', queryText);
    console.log('SQL Params:', params);
    
    const result = await db.query(queryText, params);
    return res.json(result.rows);
  } catch (error) {
    console.error('SQL Error Details:');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
    next(error);
  }
}

/**
 * Obtener un producto por ID
 */
async function getProductById(req, res, next) {
  try {
    const { id } = req.params;
    const queryText = `
      SELECT p.*, c.name as category_name 
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = $1
    `;
    const result = await db.query(queryText, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
}

/**
 * Obtener productos recomendados para venta cruzada (Cross-selling)
 * Sugiere repuestos de la misma categoría o complementarios (Eléctricos, Accesorios)
 */
async function getRecommendations(req, res, next) {
  try {
    const productId = req.params.id;

    // Primero obtener los detalles del producto base
    const baseProductQuery = 'SELECT id, category_id FROM products WHERE id = $1';
    const baseResult = await db.query(baseProductQuery, [productId]);
    
    if (baseResult.rows.length === 0) {
      return res.status(404).json({ error: 'Producto base no encontrado.' });
    }

    const baseProduct = baseResult.rows[0];

    // Buscar hasta 4 productos sugeridos:
    // Prioridad 1: Productos de la misma categoría (excluyendo el base)
    // Prioridad 2: Accesorios o eléctricos (categorías complementarias)
    // Ordenado aleatoriamente para dinamismo
    const recommendationsQuery = `
      SELECT p.*, c.name as category_name 
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id != $1 AND p.stock > 0 AND (
        p.category_id = $2 
        OR c.name IN ('Accesorios', 'Eléctrico')
      )
      ORDER BY CASE WHEN p.category_id = $2 THEN 1 ELSE 2 END, RANDOM()
      LIMIT 4
    `;
    const recResult = await db.query(recommendationsQuery, [productId, baseProduct.category_id]);
    
    return res.json(recResult.rows);
  } catch (error) {
    next(error);
  }
}

/**
 * Crear un nuevo producto (Solo Admin)
 */
async function createProduct(req, res, next) {
  try {
    const { name, description, price, stock, image_url, category_id } = req.body;

    if (!name || price === undefined || stock === undefined || !category_id) {
      return res.status(400).json({ error: 'Por favor, completa los campos requeridos (name, price, stock, category_id).' });
    }

    const insertQuery = `
      INSERT INTO products (name, description, price, stock, image_url, category_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const result = await db.query(insertQuery, [
      name,
      description || '',
      price,
      stock,
      image_url || 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=400&q=80',
      category_id,
    ]);
    const newProduct = result.rows[0];

    // Auditoría
    await logAction(
      req.user.id,
      req.user.email,
      'CREATE_PRODUCT',
      'products',
      newProduct.id,
      { name: newProduct.name, price: newProduct.price, stock: newProduct.stock }
    );

    return res.status(201).json({
      message: 'Producto creado exitosamente.',
      product: newProduct,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Actualizar un producto (Solo Admin)
 */
async function updateProduct(req, res, next) {
  try {
    const { id } = req.params;
    const { name, description, price, stock, image_url, category_id } = req.body;

    // Verificar existencia del producto
    const checkQuery = 'SELECT * FROM products WHERE id = $1';
    const checkResult = await db.query(checkQuery, [id]);
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }
    const oldProduct = checkResult.rows[0];

    const updateQuery = `
      UPDATE products
      SET name = $1, description = $2, price = $3, stock = $4, image_url = $5, category_id = $6
      WHERE id = $7
      RETURNING *
    `;
    const result = await db.query(updateQuery, [
      name || oldProduct.name,
      description !== undefined ? description : oldProduct.description,
      price !== undefined ? price : oldProduct.price,
      stock !== undefined ? stock : oldProduct.stock,
      image_url !== undefined ? image_url : oldProduct.image_url,
      category_id !== undefined ? category_id : oldProduct.category_id,
      id,
    ]);
    const updatedProduct = result.rows[0];

    // Auditoría
    await logAction(
      req.user.id,
      req.user.email,
      'UPDATE_PRODUCT',
      'products',
      updatedProduct.id,
      {
        before: { name: oldProduct.name, price: oldProduct.price, stock: oldProduct.stock },
        after: { name: updatedProduct.name, price: updatedProduct.price, stock: updatedProduct.stock }
      }
    );

    return res.json({
      message: 'Producto actualizado exitosamente.',
      product: updatedProduct,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Eliminar un producto (Solo Admin)
 * Nota: PostgreSQL manejará la eliminación en cascada en order_items y otras dependencias si existen.
 */
async function deleteProduct(req, res, next) {
  try {
    const { id } = req.params;

    // Verificar existencia
    const checkQuery = 'SELECT * FROM products WHERE id = $1';
    const checkResult = await db.query(checkQuery, [id]);
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado.' });
    }
    const product = checkResult.rows[0];

    const deleteQuery = 'DELETE FROM products WHERE id = $1 RETURNING *';
    await db.query(deleteQuery, [id]);

    // Auditoría
    await logAction(
      req.user.id,
      req.user.email,
      'DELETE_PRODUCT',
      'products',
      id,
      { name: product.name }
    );

    return res.json({ message: 'Producto eliminado exitosamente (en cascada).' });
  } catch (error) {
    next(error);
  }
}

/**
 * Obtener productos destacados (para la página principal)
 */
async function getFeaturedProducts(req, res, next) {
  try {
    const queryText = `
      SELECT p.*, c.name as category_name 
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.stock > 0
      ORDER BY 
        p.id DESC,
        RANDOM()
      LIMIT 8
    `;
    const result = await db.query(queryText);
    return res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

/**
 * Obtener todas las categorías
 */
async function getCategories(req, res, next) {
  try {
    const queryText = 'SELECT * FROM categories ORDER BY name ASC';
    const result = await db.query(queryText);
    return res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

/**
 * Crear categoría (Solo Admin)
 */
async function createCategory(req, res, next) {
  try {
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'El nombre de la categoría es requerido.' });
    }

    const insertQuery = 'INSERT INTO categories (name, description) VALUES ($1, $2) RETURNING *';
    const result = await db.query(insertQuery, [name, description || '']);
    const newCategory = result.rows[0];

    // Auditoría
    await logAction(
      req.user.id,
      req.user.email,
      'CREATE_CATEGORY',
      'categories',
      newCategory.id,
      { name: newCategory.name }
    );

    return res.status(201).json({
      message: 'Categoría creada con éxito.',
      category: newCategory
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Eliminar categoría (Solo Admin)
 * Cascade delete eliminará automáticamente todos los productos asociados debido a la relación ON DELETE CASCADE.
 */
async function deleteCategory(req, res, next) {
  try {
    const { id } = req.params;

    const checkQuery = 'SELECT * FROM categories WHERE id = $1';
    const checkResult = await db.query(checkQuery, [id]);
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Categoría no encontrada.' });
    }
    const category = checkResult.rows[0];

    const deleteQuery = 'DELETE FROM categories WHERE id = $1 RETURNING *';
    await db.query(deleteQuery, [id]);

    // Auditoría
    await logAction(
      req.user.id,
      req.user.email,
      'DELETE_CATEGORY',
      'categories',
      id,
      { name: category.name }
    );

    return res.json({ message: 'Categoría eliminada con éxito y todos sus productos asociados (en cascada).' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAllProducts,
  getProductById,
  getRecommendations,
  getFeaturedProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getCategories,
  createCategory,
  deleteCategory,
};

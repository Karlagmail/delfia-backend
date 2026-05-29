// routes/produtos.js
const express = require('express');
const pool = require('../db/pool');
const { auth, getEmpresaId } = require('../middleware/auth');
const router = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    const { ativo } = req.query;
    let q = `SELECT p.*, c.nome as categoria_nome FROM produtos p LEFT JOIN categorias c ON p.categoria_id = c.id WHERE p.empresa_id = $1`;
    const params = [empresaId];
    if (ativo !== undefined) { params.push(ativo === 'true'); q += ` AND p.ativo = $${params.length}`; }
    q += ` ORDER BY c.ordem, p.nome`;
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.get('/categorias', auth, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    const r = await pool.query('SELECT * FROM categorias WHERE empresa_id = $1 ORDER BY ordem', [empresaId]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    const r = await pool.query(
      'SELECT p.*, c.nome as categoria_nome FROM produtos p LEFT JOIN categorias c ON p.categoria_id = c.id WHERE p.id = $1 AND p.empresa_id = $2',
      [req.params.id, empresaId]
    );
    if (!r.rows[0]) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  const { nome, categoria_id, preco_conv, preco_promo, emoji, foto_url, codigo_barras, estoque, validade_dias, descricao, ingredientes, beneficios, forma_consumo, ativo, eh_kit, requer_refrigeracao, requer_congelamento } = req.body;
  if (!nome || !preco_conv) return res.status(400).json({ erro: 'Nome e preço obrigatórios' });
  try {
    const r = await pool.query(
      `INSERT INTO produtos (empresa_id, nome, categoria_id, preco_conv, preco_promo, emoji, foto_url, codigo_barras, estoque, validade_dias, descricao, ingredientes, beneficios, forma_consumo, ativo, eh_kit, requer_refrigeracao, requer_congelamento)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [empresaId, nome, categoria_id||null, preco_conv, preco_promo||null, emoji||'📦', foto_url||null, codigo_barras||null, estoque||0, validade_dias||null, descricao||null, ingredientes||null, beneficios||null, forma_consumo||null, ativo!==false, eh_kit||false, requer_refrigeracao||false, requer_congelamento||false]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.put('/:id', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  const { nome, categoria_id, preco_conv, preco_promo, emoji, foto_url, codigo_barras, estoque, validade_dias, descricao, ingredientes, beneficios, forma_consumo, ativo, eh_kit, requer_refrigeracao, requer_congelamento } = req.body;
  try {
    const r = await pool.query(
      `UPDATE produtos SET nome=$1, categoria_id=$2, preco_conv=$3, preco_promo=$4, emoji=$5, foto_url=$6, codigo_barras=$7, estoque=$8, validade_dias=$9, descricao=$10, ingredientes=$11, beneficios=$12, forma_consumo=$13, ativo=$14, eh_kit=$15, requer_refrigeracao=$16, requer_congelamento=$17, atualizado_em=NOW()
       WHERE id=$18 AND empresa_id=$19 RETURNING *`,
      [nome, categoria_id||null, preco_conv, preco_promo||null, emoji||'📦', foto_url||null, codigo_barras||null, estoque||0, validade_dias||null, descricao||null, ingredientes||null, beneficios||null, forma_consumo||null, ativo!==false, eh_kit||false, requer_refrigeracao||false, requer_congelamento||false, req.params.id, empresaId]
    );
    if (!r.rows[0]) return res.status(404).json({ erro: 'Produto não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.delete('/:id', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  try {
    await pool.query('UPDATE produtos SET ativo = false WHERE id = $1 AND empresa_id = $2', [req.params.id, empresaId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

module.exports = router;

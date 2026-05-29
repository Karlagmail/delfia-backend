// routes/insumos.js
const express = require('express');
const pool = require('../db/pool');
const { auth, getEmpresaId } = require('../middleware/auth');
const router = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    res.json((await pool.query('SELECT * FROM insumos WHERE empresa_id = $1 ORDER BY categoria, nome', [empresaId])).rows);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  const { nome, preco, unidade, categoria, fornecedor } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
  try {
    const r = await pool.query(
      'INSERT INTO insumos (empresa_id, nome, preco, unidade, categoria, fornecedor) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [empresaId, nome, preco||0, unidade||'kg', categoria||'Outros', fornecedor||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.put('/:id', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  const { nome, preco, unidade, categoria, fornecedor } = req.body;
  try {
    const r = await pool.query(
      'UPDATE insumos SET nome=$1, preco=$2, unidade=$3, categoria=$4, fornecedor=$5, atualizado_em=NOW() WHERE id=$6 AND empresa_id=$7 RETURNING *',
      [nome, preco||0, unidade||'kg', categoria||'Outros', fornecedor||null, req.params.id, empresaId]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.delete('/:id', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  try {
    await pool.query('DELETE FROM insumos WHERE id = $1 AND empresa_id = $2', [req.params.id, empresaId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

module.exports = router;

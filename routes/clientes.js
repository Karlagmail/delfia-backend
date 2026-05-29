// routes/clientes.js
const express = require('express');
const pool = require('../db/pool');
const { auth, getEmpresaId } = require('../middleware/auth');
const router = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    const { q } = req.query;
    let query = 'SELECT * FROM clientes WHERE empresa_id = $1';
    const params = [empresaId];
    if (q) { params.push(`%${q}%`); query += ` AND (nome ILIKE $${params.length} OR whatsapp ILIKE $${params.length} OR endereco ILIKE $${params.length})`; }
    query += ' ORDER BY total_gasto DESC';
    res.json((await pool.query(query, params)).rows);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    const [cli, vendas] = await Promise.all([
      pool.query('SELECT * FROM clientes WHERE id = $1 AND empresa_id = $2', [req.params.id, empresaId]),
      pool.query(
        `SELECT v.*, COALESCE(json_agg(json_build_object('nome',vi.produto_nome,'qty',vi.quantidade,'preco',vi.preco_unitario)) FILTER (WHERE vi.id IS NOT NULL),'[]') as itens
         FROM vendas v LEFT JOIN venda_itens vi ON vi.venda_id = v.id
         WHERE v.cliente_id = $1 AND v.empresa_id = $2 GROUP BY v.id ORDER BY v.criado_em DESC`,
        [req.params.id, empresaId]
      ),
    ]);
    if (!cli.rows[0]) return res.status(404).json({ erro: 'Cliente não encontrado' });
    res.json({ ...cli.rows[0], vendas: vendas.rows });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  const { nome, whatsapp, email, endereco, cep, cidade, prod_favorito, observacoes } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
  try {
    const r = await pool.query(
      'INSERT INTO clientes (empresa_id, nome, whatsapp, email, endereco, cep, cidade, prod_favorito, observacoes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [empresaId, nome, whatsapp||null, email||null, endereco||null, cep||null, cidade||null, prod_favorito||null, observacoes||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.put('/:id', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  const { nome, whatsapp, email, endereco, cep, cidade, prod_favorito, observacoes } = req.body;
  try {
    const r = await pool.query(
      'UPDATE clientes SET nome=$1,whatsapp=$2,email=$3,endereco=$4,cep=$5,cidade=$6,prod_favorito=$7,observacoes=$8,atualizado_em=NOW() WHERE id=$9 AND empresa_id=$10 RETURNING *',
      [nome, whatsapp||null, email||null, endereco||null, cep||null, cidade||null, prod_favorito||null, observacoes||null, req.params.id, empresaId]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.delete('/:id', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  try {
    await pool.query('DELETE FROM clientes WHERE id = $1 AND empresa_id = $2', [req.params.id, empresaId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

module.exports = router;

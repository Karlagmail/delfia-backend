// routes/vendas.js
const express = require('express');
const pool = require('../db/pool');
const { auth, getEmpresaId, getLojaFiltro } = require('../middleware/auth');
const router = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    const lojaFiltro = getLojaFiltro(req);
    const { status, limit = 200 } = req.query;
    let q = `SELECT v.*, l.nome as loja_nome,
      COALESCE(json_agg(json_build_object('id',vi.id,'nome',vi.produto_nome,'qty',vi.quantidade,'preco',vi.preco_unitario,'subtotal',vi.subtotal)) FILTER (WHERE vi.id IS NOT NULL), '[]') as itens
      FROM vendas v
      LEFT JOIN lojas l ON v.loja_id = l.id
      LEFT JOIN venda_itens vi ON vi.venda_id = v.id
      WHERE v.empresa_id = $1`;
    const params = [empresaId];
    if (lojaFiltro) { params.push(lojaFiltro); q += ` AND v.loja_id = $${params.length}`; }
    if (status) { params.push(status); q += ` AND v.status = $${params.length}`; }
    params.push(parseInt(limit));
    q += ` GROUP BY v.id, l.nome ORDER BY v.criado_em DESC LIMIT $${params.length}`;
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ erro: 'Erro interno' }); }
});

router.get('/stats', auth, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    const lojaFiltro = getLojaFiltro(req);
    const lojaWhere = lojaFiltro ? `AND loja_id = ${lojaFiltro}` : '';
    const hoje = new Date().toISOString().slice(0,10);
    const [totHoje, totMes, emAnd, total, porCanal] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(total),0) as val, COUNT(*) as cnt FROM vendas WHERE empresa_id=$1 AND DATE(criado_em)=$2 ${lojaWhere}`, [empresaId, hoje]),
      pool.query(`SELECT COALESCE(SUM(total),0) as val FROM vendas WHERE empresa_id=$1 AND DATE_TRUNC('month',criado_em)=DATE_TRUNC('month',NOW()) ${lojaWhere}`, [empresaId]),
      pool.query(`SELECT COUNT(*) as val FROM vendas WHERE empresa_id=$1 AND status NOT IN ('entregue','cancelado') ${lojaWhere}`, [empresaId]),
      pool.query(`SELECT COUNT(*) as val FROM vendas WHERE empresa_id=$1 ${lojaWhere}`, [empresaId]),
      pool.query(`SELECT canal, COUNT(*) as cnt, SUM(total) as total FROM vendas WHERE empresa_id=$1 ${lojaWhere} GROUP BY canal ORDER BY cnt DESC`, [empresaId]),
    ]);
    res.json({
      totalHoje: parseFloat(totHoje.rows[0].val),
      vendasHoje: parseInt(totHoje.rows[0].cnt),
      totalMes: parseFloat(totMes.rows[0].val),
      emAndamento: parseInt(emAnd.rows[0].val),
      totalVendas: parseInt(total.rows[0].val),
      porCanal: porCanal.rows,
    });
  } catch (err) { console.error(err); res.status(500).json({ erro: 'Erro interno' }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    const r = await pool.query(
      `SELECT v.*, l.nome as loja_nome,
       COALESCE(json_agg(json_build_object('id',vi.id,'nome',vi.produto_nome,'qty',vi.quantidade,'preco',vi.preco_unitario,'subtotal',vi.subtotal)) FILTER (WHERE vi.id IS NOT NULL), '[]') as itens
       FROM vendas v LEFT JOIN lojas l ON v.loja_id = l.id LEFT JOIN venda_itens vi ON vi.venda_id = v.id
       WHERE v.id = $1 AND v.empresa_id = $2 GROUP BY v.id, l.nome`,
      [req.params.id, empresaId]
    );
    if (!r.rows[0]) return res.status(404).json({ erro: 'Venda não encontrada' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  const { cliente_id, cliente_nome, canal, status, pagamento, total, desconto, frete, promo, endereco_entrega, data_entrega, observacoes, itens } = req.body;
  if (total === undefined) return res.status(400).json({ erro: 'Total obrigatório' });
  const loja_id = req.usuario.loja_id || req.body.loja_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vr = await client.query(
      `INSERT INTO vendas (empresa_id, loja_id, cliente_id, cliente_nome, canal, status, pagamento, total, desconto, frete, promo, endereco_entrega, data_entrega, observacoes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [empresaId, loja_id||null, cliente_id||null, cliente_nome||'Balcão', canal||'PDV', status||'confirmado', pagamento||null, total, desconto||0, frete||0, promo||false, endereco_entrega||null, data_entrega||null, observacoes||null]
    );
    const venda = vr.rows[0];
    if (itens?.length > 0) {
      for (const item of itens) {
        await client.query(
          'INSERT INTO venda_itens (venda_id, produto_id, produto_nome, quantidade, preco_unitario, subtotal) VALUES ($1,$2,$3,$4,$5,$6)',
          [venda.id, item.produto_id||null, item.nome||item.produto_nome, item.qty||item.quantidade||1, item.preco||item.preco_unitario, item.subtotal||(parseFloat(item.preco||0)*parseInt(item.qty||1))]
        );
      }
    }
    if (cliente_id) {
      await client.query('UPDATE clientes SET total_gasto=total_gasto+$1, total_pedidos=total_pedidos+1 WHERE id=$2 AND empresa_id=$3', [total, cliente_id, empresaId]);
    }
    await client.query('COMMIT');
    res.status(201).json(venda);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ erro: 'Erro ao criar venda' });
  } finally { client.release(); }
});

router.put('/:id', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  const { status, cliente_nome, endereco_entrega, data_entrega, observacoes, pagamento } = req.body;
  try {
    const r = await pool.query(
      `UPDATE vendas SET status=COALESCE($1,status), cliente_nome=COALESCE($2,cliente_nome), endereco_entrega=COALESCE($3,endereco_entrega), data_entrega=COALESCE($4,data_entrega), observacoes=COALESCE($5,observacoes), pagamento=COALESCE($6,pagamento), atualizado_em=NOW()
       WHERE id=$7 AND empresa_id=$8 RETURNING *`,
      [status, cliente_nome, endereco_entrega, data_entrega, observacoes, pagamento, req.params.id, empresaId]
    );
    if (!r.rows[0]) return res.status(404).json({ erro: 'Venda não encontrada' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.delete('/:id', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  try {
    await pool.query('DELETE FROM vendas WHERE id = $1 AND empresa_id = $2', [req.params.id, empresaId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

module.exports = router;

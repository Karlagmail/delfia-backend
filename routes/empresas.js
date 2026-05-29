// routes/empresas.js
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { auth, superadminOnly, adminOnly, getEmpresaId } = require('../middleware/auth');
const DominioAgent = require('../agents/dominioAgent');
const Hostinger = require('../services/hostinger');
const StripeService = require('../services/stripe');
const router = express.Router();

// ============================================================
// PLANOS (público)
// ============================================================
router.get('/planos', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM planos WHERE ativo = true ORDER BY preco_mensal');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

// ============================================================
// REGISTRO DE NOVA EMPRESA (público — trial 14 dias)
// ============================================================
router.post('/registro', async (req, res) => {
  const { nome_empresa, email_admin, senha, nome_admin, plano_slug } = req.body;
  if (!nome_empresa || !email_admin || !senha || !nome_admin) {
    return res.status(400).json({ erro: 'Campos obrigatórios: nome_empresa, email_admin, senha, nome_admin' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar e-mail único
    const emailExiste = await client.query('SELECT id FROM usuarios WHERE email = $1', [email_admin.toLowerCase()]);
    if (emailExiste.rows.length > 0) return res.status(400).json({ erro: 'E-mail já cadastrado' });

    // Gerar slug único
    let slug = nome_empresa.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
    const slugExiste = await client.query('SELECT id FROM empresas WHERE slug = $1', [slug]);
    if (slugExiste.rows.length > 0) slug = `${slug}-${Date.now()}`;

    // Pegar plano (default starter)
    const planoResult = await client.query("SELECT id FROM planos WHERE slug = $1", [plano_slug || 'starter']);
    const planoId = planoResult.rows[0]?.id || 1;

    // Criar empresa
    const emp = await client.query(
      `INSERT INTO empresas (nome, slug, email_admin, plano_id, status, trial_ate)
       VALUES ($1, $2, $3, $4, 'ativo', NOW() + INTERVAL '14 days') RETURNING *`,
      [nome_empresa, slug, email_admin.toLowerCase(), planoId]
    );
    const empresa = emp.rows[0];

    // Criar loja padrão
    const loja = await client.query(
      'INSERT INTO lojas (empresa_id, nome, tipo) VALUES ($1, $2, $3) RETURNING id',
      [empresa.id, nome_empresa, 'loja']
    );

    // Criar usuário admin
    const hash = await bcrypt.hash(senha, 10);
    await client.query(
      'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, role) VALUES ($1, $2, $3, $4, $5)',
      [empresa.id, nome_admin, email_admin.toLowerCase(), hash, 'admin']
    );

    // Categorias padrão
    const categorias = ['Produtos','Bebidas','Doces','Serviços','Outros'];
    for (let i = 0; i < categorias.length; i++) {
      await client.query('INSERT INTO categorias (empresa_id, nome, ordem) VALUES ($1, $2, $3)', [empresa.id, categorias[i], i+1]);
    }

    // Configs padrão
    await client.query(
      'INSERT INTO configuracoes (empresa_id, chave, valor) VALUES ($1, $2, $3)',
      [empresa.id, 'nome_empresa', nome_empresa]
    );

    await client.query('COMMIT');

    res.status(201).json({
      ok: true,
      empresa: { id: empresa.id, nome: empresa.nome, slug: empresa.slug },
      mensagem: `Conta criada! Você tem 14 dias de trial grátis. Login: ${email_admin}`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ erro: 'Erro ao criar conta' });
  } finally {
    client.release();
  }
});

// ============================================================
// DADOS DA EMPRESA ATUAL
// ============================================================
router.get('/minha', auth, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    if (!empresaId) return res.status(400).json({ erro: 'Use /api/empresas para superadmin' });
    const r = await pool.query(
      'SELECT e.*, p.nome as plano_nome, p.slug as plano_slug, p.max_lojas, p.max_usuarios, p.max_emails, p.modulos FROM empresas e JOIN planos p ON e.plano_id = p.id WHERE e.id = $1',
      [empresaId]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

// ============================================================
// LOJAS DA EMPRESA
// ============================================================
router.get('/lojas', auth, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    const r = await pool.query('SELECT * FROM lojas WHERE empresa_id = $1 AND ativo = true ORDER BY nome', [empresaId]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/lojas', auth, adminOnly, async (req, res) => {
  const { nome, tipo, endereco, cidade, whatsapp } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório' });
  const empresaId = getEmpresaId(req);
  try {
    // Verificar limite de lojas do plano
    const emp = await pool.query('SELECT e.*, p.max_lojas FROM empresas e JOIN planos p ON e.plano_id = p.id WHERE e.id = $1', [empresaId]);
    const maxLojas = emp.rows[0]?.max_lojas;
    if (maxLojas !== -1) {
      const countResult = await pool.query('SELECT COUNT(*) FROM lojas WHERE empresa_id = $1 AND ativo = true', [empresaId]);
      const count = parseInt(countResult.rows[0].count);
      const extras = await pool.query('SELECT COALESCE(SUM(quantidade),0) as extras FROM lojas_extras WHERE empresa_id = $1', [empresaId]);
      const totalPermitido = maxLojas + parseInt(extras.rows[0].extras);
      if (count >= totalPermitido) {
        return res.status(403).json({
          erro: `Limite de ${totalPermitido} loja(s) atingido no seu plano.`,
          pode_adicionar: true,
          preco_extra: 29.00,
          mensagem: 'Adicione mais lojas por R$ 29/loja/mês',
        });
      }
    }
    const r = await pool.query(
      'INSERT INTO lojas (empresa_id, nome, tipo, endereco, cidade, whatsapp) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [empresaId, nome, tipo||'loja', endereco||null, cidade||null, whatsapp||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

// ============================================================
// USUÁRIOS DA EMPRESA
// ============================================================
router.get('/usuarios', auth, adminOnly, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    const r = await pool.query(
      'SELECT u.id, u.nome, u.email, u.role, u.ativo, u.ultimo_login, u.criado_em, l.nome as loja_nome FROM usuarios u LEFT JOIN lojas l ON u.loja_id = l.id WHERE u.empresa_id = $1 ORDER BY u.nome',
      [empresaId]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/usuarios', auth, adminOnly, async (req, res) => {
  const { nome, email, senha, role, loja_id } = req.body;
  if (!nome || !email || !senha || !role) return res.status(400).json({ erro: 'Campos obrigatórios' });
  const empresaId = getEmpresaId(req);
  try {
    const emp = await pool.query('SELECT e.*, p.max_usuarios FROM empresas e JOIN planos p ON e.plano_id = p.id WHERE e.id = $1', [empresaId]);
    const maxUsers = emp.rows[0]?.max_usuarios;
    if (maxUsers !== -1) {
      const count = await pool.query('SELECT COUNT(*) FROM usuarios WHERE empresa_id = $1 AND ativo = true', [empresaId]);
      if (parseInt(count.rows[0].count) >= maxUsers) {
        return res.status(403).json({ erro: `Limite de ${maxUsers} usuário(s) atingido no seu plano.`, upgrade: true });
      }
    }
    const hash = await bcrypt.hash(senha, 10);
    const r = await pool.query(
      'INSERT INTO usuarios (empresa_id, loja_id, nome, email, senha_hash, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, nome, email, role',
      [empresaId, loja_id||null, nome, email.toLowerCase(), hash, role]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ erro: 'E-mail já cadastrado' });
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.put('/usuarios/:id', auth, adminOnly, async (req, res) => {
  const { nome, email, role, loja_id, ativo, nova_senha } = req.body;
  const empresaId = getEmpresaId(req);
  try {
    if (nova_senha) {
      const hash = await bcrypt.hash(nova_senha, 10);
      await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2 AND empresa_id = $3', [hash, req.params.id, empresaId]);
    }
    const r = await pool.query(
      'UPDATE usuarios SET nome=$1, email=$2, role=$3, loja_id=$4, ativo=$5, atualizado_em=NOW() WHERE id=$6 AND empresa_id=$7 RETURNING id, nome, email, role, ativo',
      [nome, email?.toLowerCase(), role, loja_id||null, ativo!==false, req.params.id, empresaId]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.delete('/usuarios/:id', auth, adminOnly, async (req, res) => {
  const empresaId = getEmpresaId(req);
  try {
    await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1 AND empresa_id = $2', [req.params.id, empresaId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

// ============================================================
// DOMÍNIOS
// ============================================================
router.post('/dominios', auth, adminOnly, async (req, res) => {
  const { dominio } = req.body;
  if (!dominio) return res.status(400).json({ erro: 'Domínio obrigatório' });
  const empresaId = getEmpresaId(req);
  try {
    const result = await DominioAgent.iniciarDominioProprio(empresaId, dominio.toLowerCase());
    res.json(result);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/dominios/:id/verificar', auth, adminOnly, async (req, res) => {
  try {
    const result = await DominioAgent.verificarEAtivar(req.params.id);
    res.json(result);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.get('/dominios', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  try {
    const r = await pool.query('SELECT * FROM dominios WHERE empresa_id = $1 ORDER BY criado_em DESC', [empresaId]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

// ============================================================
// E-MAILS — CRUD completo, nome livre pelo usuário
// ============================================================
router.get('/emails', auth, adminOnly, async (req, res) => {
  const empresaId = getEmpresaId(req);
  try {
    const r = await pool.query(
      'SELECT * FROM emails_empresa WHERE empresa_id = $1 ORDER BY email',
      [empresaId]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/emails', auth, adminOnly, async (req, res) => {
  // usuario = parte antes do @ (ex: "financeiro", "contato", "joao.silva")
  // nome_exibicao = nome que aparece nos e-mails (ex: "Financeiro Delfia")
  const { usuario, nome_exibicao } = req.body;
  const empresaId = getEmpresaId(req);

  if (!usuario) return res.status(400).json({ erro: 'Nome do usuário é obrigatório (ex: contato, financeiro)' });

  // Validar formato do usuário (apenas letras, números, pontos e hífens)
  if (!/^[a-z0-9._-]+$/.test(usuario.toLowerCase())) {
    return res.status(400).json({ erro: 'Nome inválido. Use apenas letras minúsculas, números, pontos e hífens.' });
  }

  try {
    // Verificar domínio configurado
    const emp = await pool.query(
      'SELECT e.dominio_proprio, e.dominio_configurado, p.max_emails FROM empresas e JOIN planos p ON e.plano_id = p.id WHERE e.id = $1',
      [empresaId]
    );
    const { dominio_proprio, dominio_configurado, max_emails } = emp.rows[0];

    if (!dominio_proprio || !dominio_configurado) {
      return res.status(400).json({
        erro: 'Configure e ative um domínio próprio antes de criar e-mails.',
        codigo: 'SEM_DOMINIO',
      });
    }

    if (max_emails === 0) {
      return res.status(403).json({
        erro: 'Seu plano não inclui e-mails personalizados. Faça upgrade para o Premium.',
        upgrade: true,
      });
    }

    // Verificar limite do plano
    const count = await pool.query(
      'SELECT COUNT(*) FROM emails_empresa WHERE empresa_id = $1 AND status != $2',
      [empresaId, 'excluido']
    );
    if (parseInt(count.rows[0].count) >= max_emails) {
      return res.status(403).json({
        erro: `Limite de ${max_emails} e-mail(s) atingido no seu plano.`,
        upgrade: true,
        dica: 'Faça upgrade para o Enterprise para ter até 10 e-mails.',
      });
    }

    // Verificar se e-mail já existe
    const emailCompleto = `${usuario.toLowerCase()}@${dominio_proprio}`;
    const jaExiste = await pool.query(
      'SELECT id FROM emails_empresa WHERE email = $1 AND empresa_id = $2',
      [emailCompleto, empresaId]
    );
    if (jaExiste.rows.length > 0) {
      return res.status(400).json({ erro: `O e-mail ${emailCompleto} já existe.` });
    }

    // Criar no Hostinger
    const senha = Hostinger.gerarSenha();
    const result = await Hostinger.criarEmail(
      dominio_proprio,
      usuario.toLowerCase(),
      nome_exibicao || usuario,
      senha
    );

    if (!result.ok) {
      return res.status(500).json({ erro: `Erro ao criar e-mail no servidor: ${result.erro}` });
    }

    // Salvar no banco
    await pool.query(
      'INSERT INTO emails_empresa (empresa_id, email, nome_exibicao, hostinger_account_id, status) VALUES ($1,$2,$3,$4,$5)',
      [empresaId, emailCompleto, nome_exibicao || usuario, result.id || null, 'ativo']
    );

    res.status(201).json({
      ok: true,
      email: emailCompleto,
      nome_exibicao: nome_exibicao || usuario,
      senha_inicial: senha,
      aviso: '⚠️ Salve esta senha agora! Ela não será exibida novamente. Troque no webmail após o primeiro acesso.',
      webmail: `https://webmail.hostinger.com`,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro interno ao criar e-mail' });
  }
});

// Atualizar nome de exibição de um e-mail
router.put('/emails/:id', auth, adminOnly, async (req, res) => {
  const { nome_exibicao } = req.body;
  const empresaId = getEmpresaId(req);
  try {
    const r = await pool.query(
      'UPDATE emails_empresa SET nome_exibicao = $1 WHERE id = $2 AND empresa_id = $3 RETURNING *',
      [nome_exibicao, req.params.id, empresaId]
    );
    if (!r.rows[0]) return res.status(404).json({ erro: 'E-mail não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

// Deletar e-mail — remove do Hostinger E do banco
router.delete('/emails/:id', auth, adminOnly, async (req, res) => {
  const empresaId = getEmpresaId(req);
  try {
    // Buscar e-mail para pegar o hostinger_account_id
    const r = await pool.query(
      'SELECT * FROM emails_empresa WHERE id = $1 AND empresa_id = $2',
      [req.params.id, empresaId]
    );
    if (!r.rows[0]) return res.status(404).json({ erro: 'E-mail não encontrado' });

    const emailRecord = r.rows[0];

    // Deletar no Hostinger (se tiver o ID)
    if (emailRecord.hostinger_account_id) {
      const delResult = await Hostinger.excluirEmail(emailRecord.hostinger_account_id);
      if (!delResult.ok) {
        console.warn(`Aviso: não foi possível deletar e-mail no Hostinger: ${delResult.erro}`);
        // Continua mesmo assim — marca como excluído no banco
      }
    }

    // Marcar como excluído no banco (não deletar de vez para auditoria)
    await pool.query(
      "UPDATE emails_empresa SET status = 'excluido' WHERE id = $1 AND empresa_id = $2",
      [req.params.id, empresaId]
    );

    res.json({
      ok: true,
      mensagem: `E-mail ${emailRecord.email} excluído com sucesso.`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro interno ao excluir e-mail' });
  }
});

// ============================================================
// STRIPE — Assinaturas
// ============================================================
router.post('/checkout', auth, adminOnly, async (req, res) => {
  const { plano_slug, lojas_extras } = req.body;
  const empresaId = getEmpresaId(req);
  try {
    const result = await StripeService.criarCheckout(empresaId, plano_slug, lojas_extras || 0);
    res.json(result);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/portal', auth, adminOnly, async (req, res) => {
  const empresaId = getEmpresaId(req);
  try {
    const result = await StripeService.criarPortal(empresaId);
    res.json(result);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
// SUPERADMIN — listar todas as empresas
// ============================================================
router.get('/', auth, superadminOnly, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT e.*, p.nome as plano_nome FROM empresas e JOIN planos p ON e.plano_id = p.id ORDER BY e.criado_em DESC'
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

module.exports = router;

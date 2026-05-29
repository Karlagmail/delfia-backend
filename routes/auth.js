// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { auth } = require('../middleware/auth');
const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ erro: 'Email e senha obrigatórios' });

  try {
    const emailLower = email.toLowerCase().trim();

    // Verificar se é superadmin
    const saResult = await pool.query('SELECT * FROM superadmins WHERE email = $1 AND ativo = true', [emailLower]);
    if (saResult.rows[0]) {
      const sa = saResult.rows[0];
      const ok = await bcrypt.compare(senha, sa.senha_hash);
      if (!ok) return res.status(401).json({ erro: 'Credenciais inválidas' });

      const token = jwt.sign(
        { id: sa.id, nome: sa.nome, email: sa.email, superadmin: true, role: 'superadmin' },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );
      await pool.query('UPDATE superadmins SET ultimo_login = NOW() WHERE id = $1', [sa.id]);
      return res.json({ token, usuario: { id: sa.id, nome: sa.nome, email: sa.email, role: 'superadmin', superadmin: true } });
    }

    // Usuário de empresa
    const userResult = await pool.query(
      `SELECT u.*, e.nome as empresa_nome, e.slug as empresa_slug, e.status as empresa_status,
              e.plano_id, e.trial_ate, e.logo_url, e.cor_primaria, e.cor_secundaria,
              l.nome as loja_nome, p.modulos as plano_modulos, p.slug as plano_slug
       FROM usuarios u
       JOIN empresas e ON u.empresa_id = e.id
       LEFT JOIN lojas l ON u.loja_id = l.id
       JOIN planos p ON e.plano_id = p.id
       WHERE u.email = $1 AND u.ativo = true`,
      [emailLower]
    );

    const user = userResult.rows[0];
    if (!user) return res.status(401).json({ erro: 'Credenciais inválidas' });

    // Verificar empresa ativa
    const emTrial = user.trial_ate && new Date(user.trial_ate) > new Date();
    if (user.empresa_status !== 'ativo' && !emTrial) {
      return res.status(403).json({
        erro: 'Assinatura inativa',
        mensagem: 'Acesse delfiaapp.com.br para renovar sua assinatura.',
        codigo: 'ASSINATURA_INATIVA',
      });
    }

    const ok = await bcrypt.compare(senha, user.senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Credenciais inválidas' });

    const payload = {
      id: user.id,
      nome: user.nome,
      email: user.email,
      role: user.role,
      empresa_id: user.empresa_id,
      empresa_nome: user.empresa_nome,
      empresa_slug: user.empresa_slug,
      loja_id: user.loja_id,
      loja_nome: user.loja_nome,
      plano_slug: user.plano_slug,
      modulos: user.plano_modulos,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
    await pool.query('UPDATE usuarios SET ultimo_login = NOW() WHERE id = $1', [user.id]);

    res.json({
      token,
      usuario: {
        ...payload,
        empresa_logo: user.logo_url,
        empresa_cor: user.cor_primaria,
        em_trial: emTrial,
        trial_ate: user.trial_ate,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    if (req.usuario.superadmin) {
      const r = await pool.query('SELECT id, nome, email FROM superadmins WHERE id = $1', [req.usuario.id]);
      return res.json({ ...r.rows[0], role: 'superadmin', superadmin: true });
    }
    const r = await pool.query(
      `SELECT u.id, u.nome, u.email, u.role, u.empresa_id, u.loja_id,
              e.nome as empresa_nome, e.slug as empresa_slug, e.logo_url, e.cor_primaria,
              l.nome as loja_nome, p.slug as plano_slug, p.modulos
       FROM usuarios u
       JOIN empresas e ON u.empresa_id = e.id
       LEFT JOIN lojas l ON u.loja_id = l.id
       JOIN planos p ON e.plano_id = p.id
       WHERE u.id = $1`,
      [req.usuario.id]
    );
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// PUT /api/auth/senha
router.put('/senha', auth, async (req, res) => {
  const { senha_atual, nova_senha } = req.body;
  if (!senha_atual || !nova_senha) return res.status(400).json({ erro: 'Campos obrigatórios' });
  if (nova_senha.length < 6) return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });
  try {
    const tabela = req.usuario.superadmin ? 'superadmins' : 'usuarios';
    const r = await pool.query(`SELECT senha_hash FROM ${tabela} WHERE id = $1`, [req.usuario.id]);
    const ok = await bcrypt.compare(senha_atual, r.rows[0].senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Senha atual incorreta' });
    const hash = await bcrypt.hash(nova_senha, 10);
    await pool.query(`UPDATE ${tabela} SET senha_hash = $1 WHERE id = $2`, [hash, req.usuario.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;

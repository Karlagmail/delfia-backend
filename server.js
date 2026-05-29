// server.js — Delfiaapp SaaS Backend
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const StripeService = require('./services/stripe');
const DominioAgent = require('./agents/dominioAgent');

const app = express();
const PORT = process.env.PORT || 3001;

// Health check para Railway (precisa vir antes de tudo)
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'delfiaapp-backend' }));

// ============================================================
// WEBHOOK STRIPE — precisa vir ANTES do express.json()
// ============================================================
app.post('/api/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    try {
      const result = await StripeService.processarWebhook(req.body, sig);
      res.json(result);
    } catch (err) {
      console.error('Webhook error:', err.message);
      res.status(400).json({ erro: err.message });
    }
  }
);

// ============================================================
// MIDDLEWARES
// ============================================================
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'https://app.delfiaapp.com.br',
    'https://delfiaapp.com.br',
    'https://delfiaapp.vercel.app',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    /\.delfiaapp\.com\.br$/,
  ],
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { erro: 'Muitas requisições. Tente novamente em 15 minutos.' },
});
app.use('/api/', limiter);

// Log em desenvolvimento
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    console.log(`${new Date().toLocaleTimeString('pt-BR')} ${req.method} ${req.path}`);
    next();
  });
}

// ============================================================
// ROTAS
// ============================================================
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/empresas', require('./routes/empresas'));
app.use('/api/produtos', require('./routes/produtos'));
app.use('/api/vendas',   require('./routes/vendas'));
app.use('/api/clientes', require('./routes/clientes'));
app.use('/api/insumos',  require('./routes/insumos'));

// Rotas inline (configurações, grupos)
const pool = require('./db/pool');
const { auth, adminOnly, superadminOnly, getEmpresaId } = require('./middleware/auth');

// Configurações da empresa
app.get('/api/config', auth, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    const r = await pool.query('SELECT chave, valor FROM configuracoes WHERE empresa_id = $1', [empresaId]);
    const config = {};
    r.rows.forEach(row => config[row.chave] = row.valor);
    res.json(config);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

app.put('/api/config', auth, adminOnly, async (req, res) => {
  try {
    const empresaId = getEmpresaId(req);
    for (const [chave, valor] of Object.entries(req.body)) {
      await pool.query(
        'INSERT INTO configuracoes (empresa_id, chave, valor) VALUES ($1,$2,$3) ON CONFLICT (empresa_id, chave) DO UPDATE SET valor=$3, atualizado_em=NOW()',
        [empresaId, chave, String(valor)]
      );
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

// Grupos de desconto
app.get('/api/grupos', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  try {
    res.json((await pool.query('SELECT * FROM grupos_desconto WHERE empresa_id = $1 AND ativo = true', [empresaId])).rows);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

app.post('/api/grupos', auth, adminOnly, async (req, res) => {
  const empresaId = getEmpresaId(req);
  const { nome, percentual } = req.body;
  try {
    const r = await pool.query('INSERT INTO grupos_desconto (empresa_id, nome, percentual) VALUES ($1,$2,$3) RETURNING *', [empresaId, nome, percentual||0]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

app.delete('/api/grupos/:id', auth, adminOnly, async (req, res) => {
  const empresaId = getEmpresaId(req);
  try {
    await pool.query('DELETE FROM grupos_desconto WHERE id = $1 AND empresa_id = $2', [req.params.id, empresaId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

// Categorias
app.get('/api/categorias', auth, async (req, res) => {
  const empresaId = getEmpresaId(req);
  try {
    res.json((await pool.query('SELECT * FROM categorias WHERE empresa_id = $1 ORDER BY ordem', [empresaId])).rows);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

app.post('/api/categorias', auth, adminOnly, async (req, res) => {
  const empresaId = getEmpresaId(req);
  const { nome, ordem } = req.body;
  try {
    const r = await pool.query('INSERT INTO categorias (empresa_id, nome, ordem) VALUES ($1,$2,$3) RETURNING *', [empresaId, nome, ordem||0]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

// Superadmin dashboard
app.get('/api/superadmin/stats', auth, superadminOnly, async (req, res) => {
  try {
    const [empresas, trial, ativos, receita] = await Promise.all([
      pool.query('SELECT COUNT(*) as total FROM empresas'),
      pool.query("SELECT COUNT(*) as total FROM empresas WHERE trial_ate > NOW() AND status = 'ativo'"),
      pool.query("SELECT COUNT(*) as total FROM empresas WHERE status = 'ativo' AND (trial_ate IS NULL OR trial_ate < NOW())"),
      pool.query("SELECT p.nome, COUNT(e.id) as empresas FROM planos p LEFT JOIN empresas e ON e.plano_id = p.id WHERE e.status = 'ativo' GROUP BY p.id, p.nome ORDER BY p.preco_mensal"),
    ]);
    res.json({
      total_empresas: parseInt(empresas.rows[0].total),
      em_trial: parseInt(trial.rows[0].total),
      assinantes_ativos: parseInt(ativos.rows[0].total),
      por_plano: receita.rows,
    });
  } catch (err) { res.status(500).json({ erro: 'Erro interno' }); }
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', versao: '1.0.0', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'erro', mensagem: err.message });
  }
});

// 404
app.use('/api/*', (req, res) => {
  res.status(404).json({ erro: `Rota não encontrada: ${req.method} ${req.path}` });
});

// ============================================================
// INICIAR
// ============================================================
app.listen(PORT, async () => {
  console.log(`\n🌿 Delfiaapp SaaS rodando na porta ${PORT}`);
  console.log(`📡 Health: http://localhost:${PORT}/api/health`);
  console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'development'}\n`);

  // Iniciar agente de monitoramento de domínios
  try {
    DominioAgent.iniciarMonitoramento();
  } catch (err) {
    console.log('ℹ️  Monitoramento de domínios: node-cron não disponível em desenvolvimento');
  }
});

module.exports = app;

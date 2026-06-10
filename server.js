// server.js — Delfiaapp SaaS Backend
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const StripeService = require('./services/stripe');
const DominioAgent = require('./agents/dominioAgent');

const app = express();
const PORT = process.env.PORT || 3001;

// ✅ OBRIGATÓRIO no Railway — está atrás de proxy reverso
app.set('trust proxy', 1);

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
  origin: true,
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { erro: 'Muitas requisições. Tente novamente em 15 minutos.' },
  validate: { xForwardedForHeader: false }, // Railway usa X-Forwarded-For
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

// Rota segura para retornar token HF ao frontend autenticado
app.get('/api/hf-token', auth, (req, res) => {
  const token = process.env.HF_TOKEN;
  if(!token) return res.status(500).json({ erro: 'Token não configurado' });
  res.json({ token });
});

// ============================================================
// GERAÇÃO DE IMAGEM COM IA (Hugging Face)
// ============================================================
app.post('/api/gerar-imagem', auth, async (req, res) => {
  const { prompt } = req.body;
  if(!prompt) return res.status(400).json({ erro: 'Prompt obrigatório' });

  const HF_TOKEN = process.env.HF_TOKEN;
  if(!HF_TOKEN) return res.status(500).json({ erro: 'Token HF não configurado' });

  const https = require('https');
  const promptFinal = `${prompt}, professional food photography, high quality, detailed, clean background`;

  // Função para chamar HF com retry
  async function chamarHF(model, tentativa=1){
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        inputs: promptFinal,
        parameters: model.includes('FLUX') ? { num_inference_steps: 4, guidance_scale: 0 } : {}
      });

      const options = {
        hostname: 'api-inference.huggingface.co',
        path: `/models/${model}`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 90000,
      };

      const reqHF = https.request(options, (respHF) => {
        const chunks = [];
        respHF.on('data', c => chunks.push(c));
        respHF.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: respHF.statusCode, headers: respHF.headers, buffer: buf });
        });
      });

      reqHF.on('error', reject);
      reqHF.on('timeout', () => { reqHF.destroy(); reject(new Error('timeout')); });
      reqHF.write(body);
      reqHF.end();
    });
  }

  const models = [
    'black-forest-labs/FLUX.1-schnell',
    'stabilityai/stable-diffusion-xl-base-1.0',
    'runwayml/stable-diffusion-v1-5',
  ];

  for(const model of models){
    try{
      console.log(`Tentando modelo: ${model}`);
      const r = await chamarHF(model);

      if(r.status === 200){
        const ct = r.headers['content-type'] || 'image/jpeg';
        res.setHeader('Content-Type', ct);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-store');
        console.log(`✅ Imagem gerada com ${model}`);
        return res.send(r.buffer);
      }

      // 503 = modelo carregando — aguarda e tenta de novo
      if(r.status === 503){
        console.log(`Modelo ${model} carregando (503), aguardando 10s...`);
        await new Promise(ok => setTimeout(ok, 10000));
        const r2 = await chamarHF(model);
        if(r2.status === 200){
          const ct = r2.headers['content-type'] || 'image/jpeg';
          res.setHeader('Content-Type', ct);
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'no-store');
          console.log(`✅ Imagem gerada com ${model} (2ª tentativa)`);
          return res.send(r2.buffer);
        }
      }

      console.log(`Modelo ${model} falhou com status ${r.status}`);
    }catch(err){
      console.error(`Erro modelo ${model}:`, err.message);
    }
  }

  res.status(503).json({ erro: 'Não foi possível gerar a imagem agora. Tente novamente em alguns segundos.' });
});

// ============================================================
// PROXY DE IMAGEM — para geração de fotos de produto
// ============================================================
const https = require('https');
const http = require('http');

app.get('/api/imagem', async (req, res) => {
  const q = req.query.q || 'food';
  const seed = req.query.seed || Math.floor(Math.random()*99999);
  
  // Monta URL do Unsplash
  const url = `https://source.unsplash.com/512x512/?${encodeURIComponent(q)}&sig=${seed}`;
  
  try {
    // Faz o proxy da imagem
    const proxyReq = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/*',
      }
    }, (proxyRes) => {
      // Seguir redirect (Unsplash faz redirect para CDN)
      if (proxyRes.statusCode === 301 || proxyRes.statusCode === 302 || proxyRes.statusCode === 303) {
        const redirectUrl = proxyRes.headers.location;
        const protocol = redirectUrl.startsWith('https') ? https : http;
        protocol.get(redirectUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (finalRes) => {
          res.setHeader('Content-Type', finalRes.headers['content-type'] || 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.setHeader('Access-Control-Allow-Origin', '*');
          finalRes.pipe(res);
        }).on('error', () => res.status(500).json({ erro: 'Erro ao buscar imagem' }));
        return;
      }
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Access-Control-Allow-Origin', '*');
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => res.status(500).json({ erro: 'Erro ao buscar imagem' }));
  } catch (err) {
    res.status(500).json({ erro: err.message });
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

  // Iniciar agente de monitoramento de domínios (só se banco estiver ok)
  try {
    const { Pool } = require('pg');
    const testPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
    await testPool.query('SELECT 1');
    await testPool.end();
    DominioAgent.iniciarMonitoramento();
    console.log('✅ Monitoramento de domínios ativado');
  } catch (err) {
    console.log('⚠️  Monitoramento de domínios pausado (banco indisponível):', err.message);
  }
});

module.exports = app;

-- ============================================================
-- DELFIAAPP SaaS — Schema PostgreSQL Multi-Tenant
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PLANOS
-- ============================================================
CREATE TABLE IF NOT EXISTS planos (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(50) NOT NULL,
  slug VARCHAR(30) UNIQUE NOT NULL,
  preco_mensal DECIMAL(10,2) NOT NULL,
  preco_anual DECIMAL(10,2),
  max_lojas INTEGER DEFAULT 1,
  max_usuarios INTEGER DEFAULT 2,
  max_emails INTEGER DEFAULT 0,
  permite_site BOOLEAN DEFAULT false,
  permite_ecommerce BOOLEAN DEFAULT false,
  permite_multilojas BOOLEAN DEFAULT false,
  permite_api BOOLEAN DEFAULT false,
  permite_whitelabel BOOLEAN DEFAULT false,
  permite_dominio_proprio BOOLEAN DEFAULT false,
  modulos JSONB DEFAULT '[]',
  stripe_price_id VARCHAR(100),
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMP DEFAULT NOW()
);

INSERT INTO planos (nome, slug, preco_mensal, preco_anual, max_lojas, max_usuarios, max_emails, permite_site, permite_ecommerce, permite_multilojas, permite_api, permite_whitelabel, permite_dominio_proprio, modulos) VALUES
('Starter',    'starter',    79.00,  790.00,  1,  2,  0, false, false, false, false, false, false, '["pdv","vendas","produtos"]'),
('Profissional','pro',       149.00, 1490.00, 3,  5,  0, false, false, true,  false, false, false, '["pdv","vendas","produtos","clientes","agenda","producao","precificacao"]'),
('Premium',    'premium',    299.00, 2990.00, 10, 10, 5, true,  true,  true,  false, false, true,  '["pdv","vendas","produtos","clientes","agenda","producao","precificacao","site","ecommerce","relatorios"]'),
('Enterprise', 'enterprise', 499.00, 4990.00, -1, -1, 10,true,  true,  true,  true,  true,  true,  '["pdv","vendas","produtos","clientes","agenda","producao","precificacao","site","ecommerce","relatorios","api","whitelabel"]')
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- EMPRESAS (TENANTS)
-- ============================================================
CREATE TABLE IF NOT EXISTS empresas (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(200) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  email_admin VARCHAR(100) NOT NULL,
  telefone VARCHAR(20),
  cnpj VARCHAR(20),
  endereco TEXT,
  logo_url TEXT,
  cor_primaria VARCHAR(7) DEFAULT '#1a3a2a',
  cor_secundaria VARCHAR(7) DEFAULT '#f5a623',
  plano_id INTEGER REFERENCES planos(id) DEFAULT 1,
  status VARCHAR(20) DEFAULT 'ativo',
  dominio_proprio VARCHAR(200),
  dominio_configurado BOOLEAN DEFAULT false,
  stripe_customer_id VARCHAR(100),
  stripe_subscription_id VARCHAR(100),
  trial_ate TIMESTAMP DEFAULT (NOW() + INTERVAL '14 days'),
  criado_em TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- LOJAS (por empresa)
-- ============================================================
CREATE TABLE IF NOT EXISTS lojas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(100) NOT NULL,
  tipo VARCHAR(30) DEFAULT 'loja',
  endereco TEXT,
  cidade VARCHAR(100),
  whatsapp VARCHAR(20),
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- USUÁRIOS
-- ============================================================
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE,
  loja_id INTEGER REFERENCES lojas(id),
  nome VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL,
  senha_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'loja',
  ativo BOOLEAN DEFAULT true,
  ultimo_login TIMESTAMP,
  criado_em TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW(),
  UNIQUE(empresa_id, email)
);

-- Superadmin (empresa_id NULL = acesso a tudo)
CREATE TABLE IF NOT EXISTS superadmins (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  senha_hash VARCHAR(255) NOT NULL,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- E-MAILS DAS EMPRESAS
-- ============================================================
CREATE TABLE IF NOT EXISTS emails_empresa (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  email VARCHAR(200) NOT NULL,
  nome_exibicao VARCHAR(100),
  hostinger_account_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pendente',
  criado_em TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- DOMÍNIOS
-- ============================================================
CREATE TABLE IF NOT EXISTS dominios (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  dominio VARCHAR(200) NOT NULL,
  tipo VARCHAR(20) DEFAULT 'proprio',
  provedor VARCHAR(50),
  status VARCHAR(30) DEFAULT 'pendente',
  dns_configurado BOOLEAN DEFAULT false,
  registrobr_instrucoes TEXT,
  hostinger_zone_id VARCHAR(100),
  verificado_em TIMESTAMP,
  criado_em TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- CATEGORIAS (por empresa)
-- ============================================================
CREATE TABLE IF NOT EXISTS categorias (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(50) NOT NULL,
  ordem INTEGER DEFAULT 0
);

-- ============================================================
-- PRODUTOS (por empresa)
-- ============================================================
CREATE TABLE IF NOT EXISTS produtos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(200) NOT NULL,
  categoria_id INTEGER REFERENCES categorias(id),
  preco_conv DECIMAL(10,2) NOT NULL DEFAULT 0,
  preco_promo DECIMAL(10,2),
  emoji VARCHAR(10) DEFAULT '📦',
  foto_url TEXT,
  codigo_barras VARCHAR(50),
  estoque INTEGER DEFAULT 0,
  validade_dias INTEGER,
  descricao TEXT,
  ingredientes TEXT,
  beneficios TEXT,
  forma_consumo TEXT,
  ativo BOOLEAN DEFAULT true,
  eh_kit BOOLEAN DEFAULT false,
  requer_refrigeracao BOOLEAN DEFAULT false,
  requer_congelamento BOOLEAN DEFAULT false,
  criado_em TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- CLIENTES (por empresa)
-- ============================================================
CREATE TABLE IF NOT EXISTS clientes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(200) NOT NULL,
  whatsapp VARCHAR(20),
  email VARCHAR(100),
  endereco TEXT,
  cep VARCHAR(10),
  cidade VARCHAR(100),
  prod_favorito VARCHAR(200),
  observacoes TEXT,
  total_gasto DECIMAL(10,2) DEFAULT 0,
  total_pedidos INTEGER DEFAULT 0,
  criado_em TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- VENDAS (por empresa + loja)
-- ============================================================
CREATE TABLE IF NOT EXISTS vendas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  loja_id INTEGER REFERENCES lojas(id),
  cliente_id INTEGER REFERENCES clientes(id),
  cliente_nome VARCHAR(200),
  canal VARCHAR(50) DEFAULT 'PDV',
  status VARCHAR(30) DEFAULT 'pendente',
  pagamento VARCHAR(50),
  total DECIMAL(10,2) NOT NULL DEFAULT 0,
  desconto DECIMAL(10,2) DEFAULT 0,
  frete DECIMAL(10,2) DEFAULT 0,
  promo BOOLEAN DEFAULT false,
  endereco_entrega TEXT,
  data_entrega DATE,
  observacoes TEXT,
  criado_em TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- ITENS DA VENDA
-- ============================================================
CREATE TABLE IF NOT EXISTS venda_itens (
  id SERIAL PRIMARY KEY,
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  produto_id INTEGER REFERENCES produtos(id),
  produto_nome VARCHAR(200) NOT NULL,
  quantidade INTEGER NOT NULL DEFAULT 1,
  preco_unitario DECIMAL(10,2) NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL
);

-- ============================================================
-- INSUMOS (por empresa)
-- ============================================================
CREATE TABLE IF NOT EXISTS insumos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(200) NOT NULL,
  preco DECIMAL(10,2) NOT NULL DEFAULT 0,
  unidade VARCHAR(20) DEFAULT 'kg',
  categoria VARCHAR(100) DEFAULT 'Outros',
  fornecedor VARCHAR(200),
  criado_em TIMESTAMP DEFAULT NOW(),
  atualizado_em TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- FÓRMULAS (por empresa)
-- ============================================================
CREATE TABLE IF NOT EXISTS formulas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(200) NOT NULL,
  categoria VARCHAR(100),
  rendimento INTEGER DEFAULT 1,
  peso_unidade DECIMAL(10,2),
  unidade_peso VARCHAR(5) DEFAULT 'g',
  custo_total DECIMAL(10,2) DEFAULT 0,
  custo_unitario DECIMAL(10,2) DEFAULT 0,
  processo_producao TEXT,
  observacoes TEXT,
  criado_em TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- GRUPOS DE DESCONTO (por empresa)
-- ============================================================
CREATE TABLE IF NOT EXISTS grupos_desconto (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(100) NOT NULL,
  percentual DECIMAL(5,2) NOT NULL DEFAULT 0,
  ativo BOOLEAN DEFAULT true
);

-- ============================================================
-- CONFIGURAÇÕES (por empresa)
-- ============================================================
CREATE TABLE IF NOT EXISTS configuracoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  chave VARCHAR(100) NOT NULL,
  valor TEXT,
  atualizado_em TIMESTAMP DEFAULT NOW(),
  UNIQUE(empresa_id, chave)
);

-- ============================================================
-- LOJAS EXTRAS (cobrança adicional)
-- ============================================================
CREATE TABLE IF NOT EXISTS lojas_extras (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  quantidade INTEGER NOT NULL DEFAULT 0,
  preco_unitario DECIMAL(10,2) DEFAULT 29.00,
  stripe_item_id VARCHAR(100),
  criado_em TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- ÍNDICES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_produtos_empresa ON produtos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_vendas_empresa ON vendas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_vendas_loja ON vendas(loja_id);
CREATE INDEX IF NOT EXISTS idx_vendas_status ON vendas(status);
CREATE INDEX IF NOT EXISTS idx_clientes_empresa ON clientes(empresa_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_empresa ON usuarios(empresa_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);

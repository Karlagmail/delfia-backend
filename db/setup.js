// db/setup.js
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setup() {
  console.log('\n🚀 Iniciando setup do Delfiaapp SaaS...\n');
  const client = await pool.connect();
  try {
    // 1. Criar tabelas
    console.log('📋 Criando tabelas...');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('✅ Tabelas criadas!\n');

    // 2. Criar Superadmin
    console.log('👑 Criando Superadmin...');
    const saEmail = process.env.SUPERADMIN_EMAIL || 'superadmin@delfiaapp.com.br';
    const saExiste = await client.query('SELECT id FROM superadmins WHERE email = $1', [saEmail]);
    if (saExiste.rows.length === 0) {
      const hash = await bcrypt.hash(process.env.SUPERADMIN_SENHA || 'mudar123', 10);
      await client.query(
        'INSERT INTO superadmins (nome, email, senha_hash) VALUES ($1, $2, $3)',
        [process.env.SUPERADMIN_NOME || 'Super Admin', saEmail, hash]
      );
      console.log(`✅ Superadmin criado: ${saEmail}`);
    } else {
      console.log('ℹ️  Superadmin já existe');
    }

    // 3. Criar empresa Delfia Foods
    console.log('\n🌿 Criando empresa Delfia Foods...');
    const delfiaExiste = await client.query("SELECT id FROM empresas WHERE slug = 'delfia-foods'");
    let empresaId;
    if (delfiaExiste.rows.length === 0) {
      // Pegar plano Enterprise
      const planoResult = await client.query("SELECT id FROM planos WHERE slug = 'enterprise'");
      const planoId = planoResult.rows[0]?.id || 4;

      const emp = await client.query(
        `INSERT INTO empresas (nome, slug, email_admin, plano_id, status, trial_ate, cor_primaria, cor_secundaria)
         VALUES ($1, $2, $3, $4, 'ativo', NOW() + INTERVAL '3650 days', '#1a3a2a', '#f5a623') RETURNING id`,
        ['Delfia Foods', 'delfia-foods', process.env.DELFIA_ADMIN_EMAIL || 'admin@delfiafoods.com.br', planoId]
      );
      empresaId = emp.rows[0].id;
      console.log(`✅ Empresa criada: Delfia Foods (id=${empresaId})`);

      // Criar lojas da Delfia
      const lojas = [
        { nome: 'Fábrica', tipo: 'fabrica' },
        { nome: 'Loja Arena Ice Brasil', tipo: 'loja' },
        { nome: 'Loja São Paulo FC', tipo: 'loja' },
      ];
      for (const loja of lojas) {
        const l = await client.query(
          'INSERT INTO lojas (empresa_id, nome, tipo) VALUES ($1, $2, $3) RETURNING id',
          [empresaId, loja.nome, loja.tipo]
        );
        console.log(`  ✅ Loja criada: ${loja.nome} (id=${l.rows[0].id})`);
      }

      // Criar usuários da Delfia
      const lojasList = await client.query('SELECT id, nome, tipo FROM lojas WHERE empresa_id = $1', [empresaId]);
      const usuariosDelfia = [
        { nome: 'Administrador Delfia', email: process.env.DELFIA_ADMIN_EMAIL || 'admin@delfiafoods.com.br', role: 'admin', loja_id: null },
        { nome: 'Fábrica Delfia', email: 'fabrica@delfiafoods.com.br', role: 'fabrica', loja_id: lojasList.rows.find(l=>l.tipo==='fabrica')?.id },
        { nome: 'Arena Ice Brasil', email: 'arena@delfiafoods.com.br', role: 'loja', loja_id: lojasList.rows.find(l=>l.nome.includes('Arena'))?.id },
        { nome: 'São Paulo FC', email: 'spfc@delfiafoods.com.br', role: 'loja', loja_id: lojasList.rows.find(l=>l.nome.includes('Paulo'))?.id },
      ];
      const senhaPadrao = await bcrypt.hash(process.env.DELFIA_ADMIN_SENHA || 'delfia2024', 10);
      for (const u of usuariosDelfia) {
        await client.query(
          'INSERT INTO usuarios (empresa_id, loja_id, nome, email, senha_hash, role) VALUES ($1, $2, $3, $4, $5, $6)',
          [empresaId, u.loja_id || null, u.nome, u.email, senhaPadrao, u.role]
        );
        console.log(`  ✅ Usuário criado: ${u.email} (${u.role})`);
      }

      // Configurações padrão da Delfia
      const configs = [
        ['nome_empresa', 'Delfia Foods'],
        ['custo_hora', '85.23'],
        ['meta_lucro', '17500'],
        ['promo_minimo', '3'],
        ['promo_desconto', '15'],
      ];
      for (const [chave, valor] of configs) {
        await client.query(
          'INSERT INTO configuracoes (empresa_id, chave, valor) VALUES ($1, $2, $3) ON CONFLICT (empresa_id, chave) DO NOTHING',
          [empresaId, chave, valor]
        );
      }

      // Categorias padrão da Delfia
      const categorias = ['Acompanhamentos','Bebidas','Doces','Kits','Pães','Queijos','Snacks','Sopas','Sorvetes'];
      for (let i = 0; i < categorias.length; i++) {
        await client.query(
          'INSERT INTO categorias (empresa_id, nome, ordem) VALUES ($1, $2, $3)',
          [empresaId, categorias[i], i+1]
        );
      }
      console.log(`  ✅ Categorias criadas`);

    } else {
      empresaId = delfiaExiste.rows[0].id;
      console.log('ℹ️  Empresa Delfia Foods já existe');
    }

    // Resumo final
    console.log('\n' + '='.repeat(60));
    console.log('🎉 Setup concluído com sucesso!\n');
    console.log('📝 CREDENCIAIS DE ACESSO:\n');
    console.log('  👑 SUPERADMIN (dono do SaaS):');
    console.log(`     Email: ${process.env.SUPERADMIN_EMAIL || 'superadmin@delfiaapp.com.br'}`);
    console.log(`     Senha: ${process.env.SUPERADMIN_SENHA || 'mudar123'}`);
    console.log('');
    console.log('  🌿 DELFIA FOODS (admin):');
    console.log(`     Email: ${process.env.DELFIA_ADMIN_EMAIL || 'admin@delfiafoods.com.br'}`);
    console.log(`     Senha: ${process.env.DELFIA_ADMIN_SENHA || 'delfia2024'}`);
    console.log('     fabrica@delfiafoods.com.br  (senha mesma)');
    console.log('     arena@delfiafoods.com.br    (senha mesma)');
    console.log('     spfc@delfiafoods.com.br     (senha mesma)');
    console.log('');
    console.log('  ⚠️  TROQUE AS SENHAS NO PRIMEIRO LOGIN!');
    console.log('='.repeat(60) + '\n');

  } catch (err) {
    console.error('\n❌ Erro no setup:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

setup();

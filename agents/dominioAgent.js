// agents/dominioAgent.js
// Agente inteligente para gestão de domínios
// Registro.br: manual com instruções detalhadas
// Hostinger: automático via API

const pool = require('../db/pool');
const Hostinger = require('../services/hostinger');
const cron = require('node-cron');

const DominioAgent = {

  // ============================================================
  // VERIFICAR DISPONIBILIDADE (simulado — Registro.br não tem API)
  // ============================================================
  async verificarDisponibilidade(dominio) {
    // Como Registro.br não tem API pública, fazemos DNS lookup
    const dns = require('dns').promises;
    try {
      await dns.resolve(dominio, 'A');
      return { disponivel: false, dominio };
    } catch {
      return { disponivel: true, dominio };
    }
  },

  // ============================================================
  // INICIAR PROCESSO DE DOMÍNIO PRÓPRIO
  // Fluxo: cliente informa o domínio → sistema gera instruções
  // ============================================================
  async iniciarDominioProprio(empresaId, dominio) {
    const client = await pool.connect();
    try {
      // Verificar se domínio já existe
      const existe = await client.query(
        'SELECT id FROM dominios WHERE dominio = $1',
        [dominio]
      );
      if (existe.rows.length > 0) {
        return { ok: false, erro: 'Domínio já cadastrado no sistema' };
      }

      // IP do Vercel para apontar
      const vercelIP = process.env.VERCEL_IP || '76.76.21.21';
      const appDomain = process.env.APP_DOMAIN || 'app.delfiaapp.com.br';

      // Gerar instruções para Registro.br
      const instrucoes = this.gerarInstrucoesRegistroBr(dominio, vercelIP);

      // Salvar no banco
      const result = await client.query(
        `INSERT INTO dominios (empresa_id, dominio, tipo, provedor, status, registrobr_instrucoes)
         VALUES ($1, $2, 'proprio', 'registrobr', 'aguardando_dns', $3) RETURNING id`,
        [empresaId, dominio, JSON.stringify(instrucoes)]
      );

      return {
        ok: true,
        dominio_id: result.rows[0].id,
        dominio,
        instrucoes,
        mensagem: 'Siga as instruções abaixo para configurar o DNS no Registro.br',
      };
    } finally {
      client.release();
    }
  },

  // ============================================================
  // INSTRUÇÕES PARA REGISTRO.BR
  // ============================================================
  gerarInstrucoesRegistroBr(dominio, vercelIP) {
    return {
      titulo: `Configurar DNS do domínio ${dominio} no Registro.br`,
      passos: [
        {
          numero: 1,
          titulo: 'Acesse o Registro.br',
          descricao: 'Vá para https://registro.br e faça login com seu CPF/CNPJ',
          url: 'https://registro.br/login',
        },
        {
          numero: 2,
          titulo: 'Localize seu domínio',
          descricao: `Clique no domínio "${dominio}" na lista de domínios`,
        },
        {
          numero: 3,
          titulo: 'Acesse as configurações de DNS',
          descricao: 'Clique em "Configurar Zona DNS" ou "Editar DNS"',
        },
        {
          numero: 4,
          titulo: 'Adicione os registros DNS',
          descricao: 'Adicione exatamente estes registros:',
          registros: [
            { tipo: 'A',   nome: '@',   valor: vercelIP,                    ttl: '3600', descricao: 'Aponta o domínio principal para o Delfiaapp' },
            { tipo: 'A',   nome: 'www', valor: vercelIP,                    ttl: '3600', descricao: 'Aponta www para o Delfiaapp' },
            { tipo: 'MX',  nome: '@',   valor: 'mx1.hostinger.com',         ttl: '3600', prioridade: '10', descricao: 'E-mail principal' },
            { tipo: 'MX',  nome: '@',   valor: 'mx2.hostinger.com',         ttl: '3600', prioridade: '20', descricao: 'E-mail backup' },
            { tipo: 'TXT', nome: '@',   valor: 'v=spf1 include:hostinger.com ~all', ttl: '3600', descricao: 'Autenticação de e-mail' },
          ],
        },
        {
          numero: 5,
          titulo: 'Aguarde a propagação',
          descricao: 'O DNS pode levar de 1 a 48 horas para propagar. Normalmente fica pronto em 2-4 horas.',
        },
        {
          numero: 6,
          titulo: 'Volte ao Delfiaapp e clique em "Verificar DNS"',
          descricao: 'O sistema vai verificar automaticamente se o DNS está correto e ativar seu domínio.',
        },
      ],
      aviso: 'Não altere os servidores DNS (NS) do Registro.br, apenas adicione os registros acima.',
    };
  },

  // ============================================================
  // VERIFICAR E ATIVAR DOMÍNIO
  // ============================================================
  async verificarEAtivar(dominioId) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT d.*, e.id as eid FROM dominios d JOIN empresas e ON d.empresa_id = e.id WHERE d.id = $1',
        [dominioId]
      );
      const dominio = result.rows[0];
      if (!dominio) return { ok: false, erro: 'Domínio não encontrado' };

      // Verificar DNS via Hostinger
      const verificacao = await Hostinger.verificarDNS(dominio.dominio);

      if (verificacao.propagado) {
        // DNS OK — configurar Hostinger e criar e-mails
        await client.query(
          `UPDATE dominios SET status = 'ativo', dns_configurado = true, verificado_em = NOW() WHERE id = $1`,
          [dominioId]
        );
        await client.query(
          'UPDATE empresas SET dominio_proprio = $1, dominio_configurado = true WHERE id = $2',
          [dominio.dominio, dominio.empresa_id]
        );

        // Criar e-mails automaticamente se plano permite
        const emp = await client.query(
          'SELECT e.*, p.max_emails FROM empresas e JOIN planos p ON e.plano_id = p.id WHERE e.id = $1',
          [dominio.empresa_id]
        );
        if (emp.rows[0]?.max_emails > 0) {
          const emailsResult = await Hostinger.criarEmailsEmpresa(dominio.dominio, emp.rows[0].nome);
          if (emailsResult.ok) {
            for (const em of emailsResult.emails) {
              if (em.ok) {
                await client.query(
                  'INSERT INTO emails_empresa (empresa_id, email, hostinger_account_id, status) VALUES ($1, $2, $3, $4)',
                  [dominio.empresa_id, em.email, em.id || null, 'ativo']
                );
              }
            }
            return { ok: true, ativo: true, emails_criados: emailsResult.emails, senha_emails: emailsResult.senha_padrao };
          }
        }
        return { ok: true, ativo: true };
      } else {
        return { ok: true, ativo: false, mensagem: 'DNS ainda não propagou. Tente novamente em algumas horas.' };
      }
    } finally {
      client.release();
    }
  },

  // ============================================================
  // JOB AUTOMÁTICO — Verifica domínios pendentes a cada hora
  // ============================================================
  iniciarMonitoramento() {
    cron.schedule('0 * * * *', async () => {
      console.log('🔍 Verificando domínios pendentes...');
      try {
        const result = await pool.query(
          "SELECT id FROM dominios WHERE status = 'aguardando_dns' AND criado_em > NOW() - INTERVAL '7 days'"
        );
        for (const row of result.rows) {
          await this.verificarEAtivar(row.id);
        }
      } catch (err) {
        console.error('Erro no monitoramento de domínios:', err.message);
      }
    });
    console.log('✅ Monitoramento de domínios iniciado (verificação a cada hora)');
  },
};

module.exports = DominioAgent;

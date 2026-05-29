// services/hostinger.js
// Integração com Hostinger API para DNS e e-mails
const axios = require('axios');

const api = axios.create({
  baseURL: process.env.HOSTINGER_API_URL || 'https://api.hostinger.com/v1',
  headers: {
    'Authorization': `Bearer ${process.env.HOSTINGER_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
});

const Hostinger = {

  // ============================================================
  // DNS — Configurar registros para apontar ao sistema
  // ============================================================
  async configurarDNS(dominio) {
    try {
      // Registros necessários para o Delfiaapp funcionar
      const registros = [
        // App principal
        { type: 'A',     name: '@',   value: process.env.VERCEL_IP || '76.76.21.21',  ttl: 3600 },
        { type: 'A',     name: 'www', value: process.env.VERCEL_IP || '76.76.21.21',  ttl: 3600 },
        // App (subdomínio)
        { type: 'CNAME', name: 'app', value: 'cname.vercel-dns.com',                  ttl: 3600 },
        // E-mail (Hostinger)
        { type: 'MX',    name: '@',   value: 'mx1.hostinger.com', priority: 10,       ttl: 3600 },
        { type: 'MX',    name: '@',   value: 'mx2.hostinger.com', priority: 20,       ttl: 3600 },
        // SPF para evitar spam
        { type: 'TXT',   name: '@',   value: 'v=spf1 include:hostinger.com ~all',     ttl: 3600 },
      ];

      const resultados = [];
      for (const rec of registros) {
        try {
          const res = await api.post(`/dns/zones/${dominio}/records`, rec);
          resultados.push({ ok: true, type: rec.type, name: rec.name });
        } catch (err) {
          // Registro já pode existir — não é erro crítico
          resultados.push({ ok: false, type: rec.type, name: rec.name, msg: err.response?.data?.message });
        }
      }
      return { ok: true, dominio, registros: resultados };
    } catch (err) {
      console.error('Erro ao configurar DNS Hostinger:', err.message);
      return { ok: false, erro: err.message };
    }
  },

  // ============================================================
  // Verificar propagação DNS
  // ============================================================
  async verificarDNS(dominio) {
    try {
      const res = await api.get(`/dns/zones/${dominio}/records`);
      const registros = res.data?.data || [];
      const temA = registros.some(r => r.type === 'A' && r.name === '@');
      const temMX = registros.some(r => r.type === 'MX');
      return { ok: true, propagado: temA && temMX, registros };
    } catch (err) {
      return { ok: false, propagado: false, erro: err.message };
    }
  },

  // ============================================================
  // E-MAIL — Criar conta de e-mail no Hostinger
  // ============================================================
  async criarEmail(dominio, usuario, nome, senha) {
    try {
      const email = `${usuario}@${dominio}`;
      const res = await api.post('/emails', {
        domain: dominio,
        username: usuario,
        password: senha,
        first_name: nome.split(' ')[0],
        last_name: nome.split(' ').slice(1).join(' ') || '',
        quota: 5120, // 5GB
      });
      return { ok: true, email, id: res.data?.data?.id };
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      return { ok: false, email: `${usuario}@${dominio}`, erro: msg };
    }
  },

  // ============================================================
  // Verificar se um usuário de e-mail já existe no domínio
  // ============================================================
  async verificarEmailExiste(dominio, usuario) {
    try {
      const res = await api.get(`/emails?domain=${dominio}`);
      const emails = res.data?.data || [];
      return emails.some(e => e.username === usuario && e.domain === dominio);
    } catch {
      return false;
    }
  },

  // ============================================================
  // Listar e-mails de um domínio
  // ============================================================
  async listarEmails(dominio) {
    try {
      const res = await api.get(`/emails?domain=${dominio}`);
      return { ok: true, emails: res.data?.data || [] };
    } catch (err) {
      return { ok: false, erro: err.message, emails: [] };
    }
  },

  // ============================================================
  // Excluir e-mail
  // ============================================================
  async excluirEmail(emailId) {
    try {
      await api.delete(`/emails/${emailId}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, erro: err.message };
    }
  },

  // Gera senha segura aleatória
  gerarSenha() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$!';
    return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  },
};

module.exports = Hostinger;

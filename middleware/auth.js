// middleware/auth.js
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// Autentica qualquer usuário (empresa ou superadmin)
async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token não fornecido' });
  }
  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.usuario = decoded;

    // Verificar se empresa está ativa (exceto superadmin)
    if (!decoded.superadmin && decoded.empresa_id) {
      const emp = await pool.query(
        'SELECT e.status, e.plano_id, e.trial_ate, p.modulos FROM empresas e JOIN planos p ON e.plano_id = p.id WHERE e.id = $1',
        [decoded.empresa_id]
      );
      if (!emp.rows[0]) return res.status(401).json({ erro: 'Empresa não encontrada' });

      const empresa = emp.rows[0];
      const emTrial = empresa.trial_ate && new Date(empresa.trial_ate) > new Date();
      if (empresa.status !== 'ativo' && !emTrial) {
        return res.status(403).json({ erro: 'Assinatura inativa. Acesse delfiaapp.com.br para renovar.' });
      }
      req.empresa = empresa;
      req.modulos = empresa.modulos || [];
    }
    next();
  } catch (err) {
    return res.status(401).json({ erro: 'Token inválido ou expirado' });
  }
}

// Apenas superadmin do SaaS
function superadminOnly(req, res, next) {
  if (!req.usuario?.superadmin) {
    return res.status(403).json({ erro: 'Acesso restrito ao superadmin' });
  }
  next();
}

// Apenas admin da empresa
function adminOnly(req, res, next) {
  if (req.usuario?.superadmin) return next(); // superadmin passa tudo
  if (!['admin'].includes(req.usuario?.role)) {
    return res.status(403).json({ erro: 'Acesso restrito a administradores' });
  }
  next();
}

// Admin ou fábrica
function fabricaOuAdmin(req, res, next) {
  if (req.usuario?.superadmin) return next();
  if (!['admin', 'fabrica'].includes(req.usuario?.role)) {
    return res.status(403).json({ erro: 'Acesso restrito' });
  }
  next();
}

// Verifica se o módulo está disponível no plano da empresa
function requireModulo(modulo) {
  return (req, res, next) => {
    if (req.usuario?.superadmin) return next();
    const modulos = req.modulos || [];
    if (!modulos.includes(modulo)) {
      return res.status(403).json({
        erro: `Módulo "${modulo}" não disponível no seu plano atual.`,
        upgrade: true,
        plano_atual: req.empresa?.plano_id,
      });
    }
    next();
  };
}

// Retorna o empresa_id do token (null para superadmin)
function getEmpresaId(req) {
  return req.usuario?.superadmin ? null : req.usuario?.empresa_id;
}

// Retorna loja_id se o usuário for de loja específica
function getLojaFiltro(req) {
  if (req.usuario?.superadmin) return null;
  if (['admin', 'fabrica'].includes(req.usuario?.role)) return null;
  return req.usuario?.loja_id || null;
}

module.exports = { auth, superadminOnly, adminOnly, fabricaOuAdmin, requireModulo, getEmpresaId, getLojaFiltro };

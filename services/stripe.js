// services/stripe.js
const Stripe = require('stripe');
const pool = require('../db/pool');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Mapa de planos → Stripe Price IDs
const PLANOS_STRIPE = {
  starter:    process.env.STRIPE_PRICE_STARTER,
  pro:        process.env.STRIPE_PRICE_PRO,
  premium:    process.env.STRIPE_PRICE_PREMIUM,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
  loja_extra: process.env.STRIPE_PRICE_LOJA_EXTRA,
};

const StripeService = {

  // ============================================================
  // Criar cliente no Stripe
  // ============================================================
  async criarCliente(empresa) {
    const customer = await stripe.customers.create({
      name: empresa.nome,
      email: empresa.email_admin,
      metadata: { empresa_id: String(empresa.id), slug: empresa.slug },
    });
    await pool.query('UPDATE empresas SET stripe_customer_id = $1 WHERE id = $2', [customer.id, empresa.id]);
    return customer;
  },

  // ============================================================
  // Criar sessão de checkout para assinar plano
  // ============================================================
  async criarCheckout(empresaId, planoSlug, lojas_extras = 0) {
    const emp = await pool.query('SELECT * FROM empresas WHERE id = $1', [empresaId]);
    const empresa = emp.rows[0];
    if (!empresa) throw new Error('Empresa não encontrada');

    let customerId = empresa.stripe_customer_id;
    if (!customerId) {
      const customer = await this.criarCliente(empresa);
      customerId = customer.id;
    }

    const lineItems = [];

    // Plano principal
    const priceId = PLANOS_STRIPE[planoSlug];
    if (!priceId) throw new Error(`Price ID não configurado para plano: ${planoSlug}`);
    lineItems.push({ price: priceId, quantity: 1 });

    // Lojas extras
    if (lojas_extras > 0 && PLANOS_STRIPE.loja_extra) {
      lineItems.push({ price: PLANOS_STRIPE.loja_extra, quantity: lojas_extras });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: lineItems,
      success_url: `${process.env.FRONTEND_URL}/sucesso?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/planos?cancelado=1`,
      metadata: { empresa_id: String(empresaId), plano: planoSlug, lojas_extras: String(lojas_extras) },
      subscription_data: {
        metadata: { empresa_id: String(empresaId), plano: planoSlug },
        trial_period_days: empresa.trial_ate && new Date(empresa.trial_ate) > new Date() ? null : 14,
      },
      locale: 'pt-BR',
    });

    return { url: session.url, session_id: session.id };
  },

  // ============================================================
  // Portal do cliente (gerenciar assinatura)
  // ============================================================
  async criarPortal(empresaId) {
    const emp = await pool.query('SELECT stripe_customer_id FROM empresas WHERE id = $1', [empresaId]);
    const customerId = emp.rows[0]?.stripe_customer_id;
    if (!customerId) throw new Error('Cliente Stripe não encontrado');

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${process.env.FRONTEND_URL}/configuracoes/plano`,
    });
    return { url: session.url };
  },

  // ============================================================
  // Webhook — processar eventos do Stripe
  // ============================================================
  async processarWebhook(body, signature) {
    let event;
    try {
      event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      throw new Error(`Webhook inválido: ${err.message}`);
    }

    const client = await pool.connect();
    try {
      switch (event.type) {

        case 'checkout.session.completed': {
          const session = event.data.object;
          const { empresa_id, plano, lojas_extras } = session.metadata;
          const planoResult = await client.query('SELECT id FROM planos WHERE slug = $1', [plano]);
          const plano_id = planoResult.rows[0]?.id;

          await client.query(
            `UPDATE empresas SET
               plano_id = $1,
               status = 'ativo',
               stripe_subscription_id = $2,
               trial_ate = NULL,
               atualizado_em = NOW()
             WHERE id = $3`,
            [plano_id, session.subscription, empresa_id]
          );

          // Registrar lojas extras
          if (parseInt(lojas_extras) > 0) {
            await client.query(
              `INSERT INTO lojas_extras (empresa_id, quantidade, stripe_item_id)
               VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING`,
              [empresa_id, parseInt(lojas_extras), session.subscription]
            );
          }
          console.log(`✅ Assinatura ativada: empresa ${empresa_id} → plano ${plano}`);
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const custResult = await client.query(
            'SELECT id FROM empresas WHERE stripe_customer_id = $1',
            [invoice.customer]
          );
          if (custResult.rows[0]) {
            await client.query(
              "UPDATE empresas SET status = 'inadimplente' WHERE id = $1",
              [custResult.rows[0].id]
            );
            console.log(`⚠️  Pagamento falhou: empresa ${custResult.rows[0].id}`);
          }
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const custResult = await client.query(
            'SELECT id FROM empresas WHERE stripe_customer_id = $1',
            [sub.customer]
          );
          if (custResult.rows[0]) {
            await client.query(
              "UPDATE empresas SET status = 'cancelado' WHERE id = $1",
              [custResult.rows[0].id]
            );
            console.log(`❌ Assinatura cancelada: empresa ${custResult.rows[0].id}`);
          }
          break;
        }

        case 'invoice.payment_succeeded': {
          const invoice = event.data.object;
          const custResult = await client.query(
            'SELECT id FROM empresas WHERE stripe_customer_id = $1',
            [invoice.customer]
          );
          if (custResult.rows[0]) {
            await client.query(
              "UPDATE empresas SET status = 'ativo', atualizado_em = NOW() WHERE id = $1",
              [custResult.rows[0].id]
            );
          }
          break;
        }
      }
    } finally {
      client.release();
    }

    return { received: true, type: event.type };
  },
};

module.exports = StripeService;

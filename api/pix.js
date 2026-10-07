const BLACKCAT_DEFAULT_URL = 'https://api.blackcatoficial.com/api/sales/create-sale';
const SHARPIFY_DEFAULT_URL = 'https://sharpify-pay.com/api/v1/gateway/payment/create-paymnet';

function cleanProvider(value) {
  const provider = String(value || process.env.PAYMENT_GATEWAY || 'blackcat').trim().toLowerCase();
  return provider === 'sharpify' || provider === 'shapfy' ? 'sharpify' : 'blackcat';
}

function buildExternalRef() {
  return `RTH-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${crypto.randomUUID().slice(0, 8)}`;
}

async function createBlackcat({ amount, input, metadata }) {
  const apiKey = process.env.BLACKCAT_API_KEY;
  if (!apiKey) throw new Error('BLACKCAT_API_KEY não configurada na Vercel.');

  const url = process.env.BLACKCAT_API_URL || BLACKCAT_DEFAULT_URL;
  const payload = {
    amount: Math.round(amount * 100),
    currency: 'BRL',
    paymentMethod: 'pix',
    items: [{ title: input.product_name || 'Recarga de Celular - Recarga Fácil', quantity: 1, tangible: false }],
    customer: {
      name: process.env.BLACKCAT_CLIENT_NAME || 'Recarga Fácil',
      email: process.env.BLACKCAT_CLIENT_EMAIL || 'contato@recargatodahora.online',
      phone: String(metadata.telefone || '11999999999'),
      document: { number: process.env.BLACKCAT_CLIENT_DOCUMENT || '', type: 'cpf' }
    },
    pix: { expiresInDays: 1 },
    metadata,
    ...(process.env.BLACKCAT_POSTBACK_URL ? { postbackUrl: process.env.BLACKCAT_POSTBACK_URL } : {}),
    externalRef: buildExternalRef()
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.data?.paymentData) {
    const error = new Error(data?.message || data?.error || 'A API Blackcat não retornou um Pix válido.');
    error.status = response.status || 502;
    throw error;
  }

  const paymentData = data.data.paymentData;
  return {
    provider: 'blackcat',
    paymentData: {
      copyPaste: paymentData.copyPaste || paymentData.qrCode || '',
      qrCodeBase64: paymentData.qrCodeBase64 || null,
      qrCode: paymentData.qrCode || ''
    },
    transactionId: data.data.transactionId || null,
    status: data.data.status || 'PENDING',
    amount: data.data.amount || Math.round(amount * 100),
    amountDisplay: amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    invoiceUrl: data.data.invoiceUrl || null
  };
}

async function createSharpify({ amount, input, metadata }) {
  const clientId = process.env.SHARPIFY_CLIENT_ID;
  const clientSecret = process.env.SHARPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SHARPIFY_CLIENT_ID e SHARPIFY_CLIENT_SECRET precisam estar configuradas na Vercel.');
  }

  const url = process.env.SHARPIFY_API_URL || SHARPIFY_DEFAULT_URL;
  const callbackURL = process.env.SHARPIFY_WEBHOOK_URL || process.env.SHARPIFY_CALLBACK_URL;
  const webhook = callbackURL
    ? {
        callbackURL,
        ...(process.env.SHARPIFY_WEBHOOK_AUTH
          ? { headers: [{ key: 'Authorization', value: process.env.SHARPIFY_WEBHOOK_AUTH }] }
          : {})
      }
    : undefined;

  const payload = {
    name: input.product_name || `Recarga ${metadata.operadora || ''}`.trim(),
    description: `Recarga de celular${metadata.operadora ? ` - ${metadata.operadora}` : ''}${metadata.telefone ? ` - ${metadata.telefone}` : ''}`,
    amount: Number(amount.toFixed(2)),
    gatewayMethod: 'PIX',
    ...(webhook ? { webhook } : {})
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sharpify-client-id': clientId,
      'x-sharpify-client-secret': clientSecret
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.data) {
    const error = new Error(data?.message || data?.error || 'A API Sharpify não retornou um pagamento válido.');
    error.status = response.status || 502;
    throw error;
  }

  const paymentLink = data.data;
  const gatewayData = paymentLink?.payment?.gateway?.data || {};
  const copyPaste = gatewayData.code || gatewayData.qrCode || '';

  return {
    provider: 'sharpify',
    paymentData: {
      copyPaste,
      qrCodeBase64: typeof gatewayData.qrCode === 'string' && gatewayData.qrCode.startsWith('data:image/') ? gatewayData.qrCode : null,
      qrCode: gatewayData.qrCode || '',
      paymentLink: gatewayData.paymentLink || null
    },
    transactionId: paymentLink.id || paymentLink.payment?.id || null,
    status: paymentLink.status || 'PENDING',
    amount: Math.round(Number(paymentLink.payment?.amount ?? amount) * 100),
    amountDisplay: amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    invoiceUrl: gatewayData.paymentLink || null,
    shortReference: paymentLink.shortReference || null
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Método não permitido' });

  const input = req.body || {};
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0.01 || amount > 1000) {
    return res.status(400).json({ success: false, message: 'amount deve ser um número entre 0,01 e 1.000.' });
  }

  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const provider = cleanProvider(input.gateway);

  try {
    const data = provider === 'sharpify'
      ? await createSharpify({ amount, input, metadata })
      : await createBlackcat({ amount, input, metadata });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    const message = error?.message || 'Não foi possível gerar o pagamento.';
    return res.status(error?.status || 502).json({ success: false, gateway: provider, message });
  }
}

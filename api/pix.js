const SHARPIFY_DEFAULT_URL =
  'https://sharpify-pay.com/api/v1/gateway/payment/create-paymnet';

function buildExternalRef() {
  return `RTH-${new Date()
    .toISOString()
    .slice(0, 10)
    .replaceAll('-', '')}-${crypto.randomUUID().slice(0, 8)}`;
}

async function createSharpify({ amount, input, metadata }) {
  const clientId = process.env.SHARPIFY_CLIENT_ID;
  const clientSecret = process.env.SHARPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const error = new Error(
      'SHARPIFY_CLIENT_ID e SHARPIFY_CLIENT_SECRET precisam estar configuradas na Vercel.'
    );

    error.status = 500;
    throw error;
  }

  const url =
    process.env.SHARPIFY_API_URL || SHARPIFY_DEFAULT_URL;

  const callbackURL =
    process.env.SHARPIFY_WEBHOOK_URL ||
    process.env.SHARPIFY_CALLBACK_URL;

  const webhook = callbackURL
    ? {
        callbackURL,
        ...(process.env.SHARPIFY_WEBHOOK_AUTH
          ? {
              headers: [
                {
                  key: 'Authorization',
                  value: process.env.SHARPIFY_WEBHOOK_AUTH
                }
              ]
            }
          : {})
      }
    : undefined;

  const payload = {
    name:
      input.product_name ||
      `Recarga ${metadata.operadora || ''}`.trim(),

    description:
      `Recarga de celular` +
      (metadata.operadora
        ? ` - ${metadata.operadora}`
        : '') +
      (metadata.telefone
        ? ` - ${metadata.telefone}`
        : ''),

    amount: Number(amount.toFixed(2)),

    gatewayMethod: 'PIX',

    ...(webhook ? { webhook } : {}),

    externalRef: buildExternalRef()
  };

  let response;

  try {
    response = await fetch(url, {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        'x-sharpify-client-id': clientId,
        'x-sharpify-client-secret': clientSecret
      },

      body: JSON.stringify(payload)
    });
  } catch (networkError) {
    const error = new Error(
      `Não foi possível conectar à API Sharpify: ${
        networkError?.message || 'erro de conexão'
      }`
    );

    error.status = 502;
    throw error;
  }

  const rawText = await response.text();

  let data = {};

  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = {
      raw: rawText
    };
  }

  if (!response.ok) {
    const apiMessage =
      data?.message ||
      data?.error ||
      data?.detail ||
      data?.raw ||
      `A API Sharpify retornou HTTP ${response.status}.`;

    const error = new Error(
      typeof apiMessage === 'string'
        ? apiMessage
        : JSON.stringify(apiMessage)
    );

    error.status = response.status || 502;
    throw error;
  }

  if (!data?.data) {
    const error = new Error(
      data?.message ||
        data?.error ||
        'A API Sharpify não retornou os dados do pagamento.'
    );

    error.status = 502;
    throw error;
  }

  const paymentLink = data.data;

  const gatewayData =
    paymentLink?.payment?.gateway?.data || {};

  const copyPaste =
    gatewayData.code ||
    gatewayData.copyPaste ||
    gatewayData.qrCode ||
    '';

  const qrCode =
    gatewayData.qrCode ||
    gatewayData.qrCodeBase64 ||
    '';

  const paymentLinkUrl =
    gatewayData.paymentLink ||
    paymentLink?.paymentLink ||
    paymentLink?.url ||
    null;

  return {
    provider: 'sharpify',

    paymentData: {
      copyPaste,

      qrCodeBase64:
        typeof qrCode === 'string' &&
        qrCode.startsWith('data:image/')
          ? qrCode
          : null,

      qrCode,

      paymentLink: paymentLinkUrl
    },

    transactionId:
      paymentLink.id ||
      paymentLink.payment?.id ||
      null,

    status:
      paymentLink.status ||
      paymentLink.payment?.status ||
      'PENDING',

    amount:
      Math.round(
        Number(
          paymentLink.payment?.amount ?? amount
        ) * 100
      ),

    amountDisplay:
      amount.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL'
      }),

    invoiceUrl: paymentLinkUrl,

    shortReference:
      paymentLink.shortReference || null
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Método não permitido'
    });
  }

  const input = req.body || {};

  const amount = Number(input.amount);

  if (
    !Number.isFinite(amount) ||
    amount < 0.01 ||
    amount > 1000
  ) {
    return res.status(400).json({
      success: false,
      message:
        'amount deve ser um número entre 0,01 e 1.000.'
    });
  }

  const metadata =
    input.metadata &&
    typeof input.metadata === 'object'
      ? input.metadata
      : {};

  try {
    const data = await createSharpify({
      amount,
      input,
      metadata
    });

    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    const message =
      error?.message ||
      'Não foi possível gerar o pagamento.';

    return res.status(error?.status || 502).json({
      success: false,
      gateway: 'sharpify',
      message
    });
  }
}

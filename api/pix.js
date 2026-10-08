
const SHARPIFY_DEFAULT_URL =
  'https://sharpify-pay.com/api/v1/gateway/payment/create-paymnet';

const clean = value => String(value ?? '').trim();
const onlyDigits = value => String(value ?? '').replace(/\D/g, '');

function formatBRL(value) {
  return Number(value).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function errorMessage(value) {
  if (!value) return 'Erro desconhecido retornado pela Sharpify.';
  if (typeof value === 'string') return value;
  if (value.message) return errorMessage(value.message);
  if (value.error) return errorMessage(value.error);
  if (value.detail) return errorMessage(value.detail);

  try {
    return JSON.stringify(value);
  } catch {
    return 'Erro retornado pela Sharpify.';
  }
}

function getWebhookUrl(req) {
  const configured = clean(process.env.SHARPIFY_WEBHOOK_URL);

  if (configured) return configured;

  const host =
    clean(req?.headers?.['x-forwarded-host']) ||
    clean(req?.headers?.host);

  if (!host) return null;

  const protocol =
    clean(req?.headers?.['x-forwarded-proto']) || 'https';

  return `${protocol}://${host}/api/pix`;
}

async function createSharpifyPayment({ amount, metadata, req }) {
  const clientId = clean(process.env.SHARPIFY_CLIENT_ID);
  const clientSecret = clean(process.env.SHARPIFY_CLIENT_SECRET);

  if (!clientId || !clientSecret) {
    const error = new Error(
      'Configure SHARPIFY_CLIENT_ID e SHARPIFY_CLIENT_SECRET na Vercel.'
    );
    error.status = 500;
    throw error;
  }

  const apiUrl =
    clean(process.env.SHARPIFY_API_URL) ||
    SHARPIFY_DEFAULT_URL;

  const telefone = onlyDigits(metadata?.telefone);
  const operadora = clean(metadata?.operadora) || 'Celular';

  const payload = {
    name: `Recarga Fácil - Recarga ${operadora}`,
    description: [
      `Operadora: ${operadora}`,
      telefone ? `Telefone: ${telefone}` : null,
      `Valor: ${formatBRL(amount)}`
    ].filter(Boolean).join(' | '),
    amount: Number(Number(amount).toFixed(2)),
    gatewayMethod: 'PIX'
  };

  const webhookURL = getWebhookUrl(req);

  if (webhookURL) {
    payload.webhook = {
      callbackURL: webhookURL
    };
  }

  let response;

  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sharpify-client-id': clientId,
        'x-sharpify-client-secret': clientSecret
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    const error = new Error(
      `Falha de conexão com a Sharpify: ${
        err?.message || 'erro desconhecido'
      }`
    );
    error.status = 502;
    throw error;
  }

  const responseText = await response.text();
  let result;

  try {
    result = responseText ? JSON.parse(responseText) : {};
  } catch {
    result = { raw: responseText };
  }

  if (!response.ok) {
    console.error(
      'Sharpify HTTP:',
      response.status,
      JSON.stringify(result)
    );

    const error = new Error(
      `Sharpify HTTP ${response.status}: ${errorMessage(
        result?.message ||
        result?.error ||
        result?.detail ||
        result?.raw ||
        'Erro na API'
      )}`
    );

    error.status = response.status;
    throw error;
  }

  const link = result?.data;

  if (!link || typeof link !== 'object') {
    const error = new Error(
      'A Sharpify respondeu sem os dados do pagamento.'
    );
    error.status = 502;
    throw error;
  }

  const payment = link.payment || {};
  const gateway = payment.gateway || {};
  const gatewayData = gateway.data || {};

  const copyPaste = clean(gatewayData.code);
  const qrCode = clean(gatewayData.qrCode);
  const paymentLinkUrl = clean(gatewayData.paymentLink);

  if (!copyPaste && !qrCode && !paymentLinkUrl) {
    const error = new Error(
      'A Sharpify não retornou código Pix, QR Code ou link de pagamento.'
    );
    error.status = 502;
    throw error;
  }

  const finalAmount = Number(
    payment.amount ?? link.pricing?.total ?? amount
  );

  return {
    provider: 'sharpify',
    paymentLinkId: link.id || null,
    transactionId: payment.id || link.id || null,
    shortReference: link.shortReference || null,
    status: link.status || 'PENDING',
    amount: Math.round(finalAmount * 100),
    amountDisplay: formatBRL(finalAmount),

    paymentData: {
      copyPaste: copyPaste || null,
      qrCode: qrCode || null,
      qrCodeBase64: qrCode.startsWith('data:image/')
        ? qrCode
        : null,
      paymentLink: paymentLinkUrl || null
    },

    invoiceUrl: paymentLinkUrl || null
  };
}

async function handleSharpifyWebhook(req, res) {
  const body =
    req.body && typeof req.body === 'object'
      ? req.body
      : {};

  const event = body.event || {};
  const eventName = clean(event.name);
  const webhookId = clean(event.webhookId);
  const paymentLink = body?.data?.paymentLink || {};

  if (
    ![
      'PAYMENT_LINK_APPROVED',
      'PAYMENT_LINK_CANCELLED'
    ].includes(eventName)
  ) {
    return res.status(400).json({
      success: false,
      message: 'Evento de webhook não reconhecido.'
    });
  }

  console.log('Sharpify webhook recebido:', JSON.stringify({
    webhookId: webhookId || null,
    event: eventName,
    paymentLinkId: paymentLink.id || event.contextId || null,
    paymentId: paymentLink?.payment?.id || null,
    status: paymentLink.status || null,
    amount:
      paymentLink?.payment?.amount ??
      paymentLink?.pricing?.total ??
      null
  }));

  // Este código registra o evento, mas não executa a recarga.
  // A persistência e a idempotência exigem armazenamento durável.

  return res.status(200).json({
    success: true,
    received: true,
    webhookId: webhookId || null,
    event: eventName
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      gateway: 'sharpify',
      message: 'Método não permitido.'
    });
  }

  const eventName = clean(req.body?.event?.name);

  if (
    [
      'PAYMENT_LINK_APPROVED',
      'PAYMENT_LINK_CANCELLED'
    ].includes(eventName)
  ) {
    try {
      return await handleSharpifyWebhook(req, res);
    } catch (err) {
      console.error(
        'Erro no webhook Sharpify:',
        err?.message || err
      );

      return res.status(500).json({
        success: false,
        message: 'Erro ao processar webhook.'
      });
    }
  }

  try {
    const body =
      req.body && typeof req.body === 'object'
        ? req.body
        : {};

    const amount = Number(body.amount);

    if (
      !Number.isFinite(amount) ||
      amount < 0.01 ||
      amount > 1000
    ) {
      return res.status(400).json({
        success: false,
        gateway: 'sharpify',
        message: 'O valor deve estar entre R$ 0,01 e R$ 1.000,00.'
      });
    }

    const metadata =
      body.metadata && typeof body.metadata === 'object'
        ? body.metadata
        : {};

    const payment = await createSharpifyPayment({
      amount,
      metadata,
      req
    });

    return res.status(200).json({
      success: true,
      gateway: 'sharpify',
      data: payment
    });
  } catch (err) {
    console.error(
      'Erro Sharpify:',
      err?.message || err
    );

    const status =
      Number(err?.status) >= 400 &&
      Number(err.status) <= 599
        ? Number(err.status)
        : 502;

    return res.status(status).json({
      success: false,
      gateway: 'sharpify',
      message: errorMessage(err?.message || err)
    });
  }
}

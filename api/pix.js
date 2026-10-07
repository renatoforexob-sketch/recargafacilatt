const SHARPIFY_DEFAULT_URL =
  'https://sharpify-pay.com/api/v1/gateway/payment/create-paymnet';

function normalizeMessage(value) {
  if (!value) {
    return 'A Sharpify recusou a solicitação.';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value.message) {
    return normalizeMessage(value.message);
  }

  if (value.error) {
    return normalizeMessage(value.error);
  }

  if (value.detail) {
    return normalizeMessage(value.detail);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return 'Erro retornado pela Sharpify.';
  }
}

function clean(value) {
  return String(value ?? '').trim();
}

async function createSharpify({
  amount,
  input,
  metadata
}) {
  const clientId =
    process.env.SHARPIFY_CLIENT_ID;

  const clientSecret =
    process.env.SHARPIFY_CLIENT_SECRET;

  if (!clientId) {
    const error = new Error(
      'SHARPIFY_CLIENT_ID não configurado na Vercel.'
    );

    error.status = 500;

    throw error;
  }

  if (!clientSecret) {
    const error = new Error(
      'SHARPIFY_CLIENT_SECRET não configurado na Vercel.'
    );

    error.status = 500;

    throw error;
  }

  const url =
    process.env.SHARPIFY_API_URL ||
    SHARPIFY_DEFAULT_URL;

  const telefone = clean(
    metadata?.telefone
  );

  const operadora = clean(
    metadata?.operadora
  );

  const name =
    clean(input?.product_name) ||
    `Recarga ${operadora || 'Celular'}`;

  const description = [
    'Recarga de celular',
    operadora
      ? `Operadora: ${operadora}`
      : '',
    telefone
      ? `Telefone: ${telefone}`
      : ''
  ]
    .filter(Boolean)
    .join(' - ');

  /*
   * PAYLOAD EXATO DO ENDPOINT SHARPIFY
   *
   * name: obrigatório
   * description: opcional
   * amount: obrigatório
   * gatewayMethod: obrigatório
   */
  const payload = {
    name,
    description,
    amount: Number(
      Number(amount).toFixed(2)
    ),
    gatewayMethod: 'PIX'
  };

  let response;

  try {
    response = await fetch(url, {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/json',

        'x-sharpify-client-id':
          clientId,

        'x-sharpify-client-secret':
          clientSecret
      },

      body: JSON.stringify(payload)
    });
  } catch (err) {
    const error = new Error(
      `Falha de conexão com a Sharpify: ${
        err?.message ||
        'erro desconhecido'
      }`
    );

    error.status = 502;

    throw error;
  }

  const rawText =
    await response.text();

  let data = {};

  try {
    data = rawText
      ? JSON.parse(rawText)
      : {};
  } catch {
    data = {
      raw: rawText
    };
  }

  /*
   * AQUI ESTÁ A PARTE IMPORTANTE:
   * não esconderemos a resposta da Sharpify.
   */
  if (!response.ok) {
    const apiError =
      data?.message ||
      data?.error ||
      data?.detail ||
      data?.raw ||
      `HTTP ${response.status}`;

    const message =
      normalizeMessage(apiError);

    const error = new Error(
      `Sharpify HTTP ${response.status}: ${message}`
    );

    error.status =
      response.status;

    throw error;
  }

  /*
   * Documentação Sharpify:
   *
   * {
   *   data: PaymentLinkProps
   * }
   */
  const paymentLink =
    data?.data;

  if (
    !paymentLink ||
    typeof paymentLink !== 'object'
  ) {
    const error = new Error(
      'A Sharpify respondeu sem data do pagamento.'
    );

    error.status = 502;

    throw error;
  }

  const payment =
    paymentLink.payment ||
    null;

  const gateway =
    payment?.gateway ||
    null;

  const gatewayData =
    gateway?.data ||
    {};

  /*
   * Segundo a documentação:
   *
   * payment.gateway.data.code
   * payment.gateway.data.qrCode
   * payment.gateway.data.paymentLink
   */
  const copyPaste =
    gatewayData.code ||
    '';

  const qrCode =
    gatewayData.qrCode ||
    '';

  const paymentLinkUrl =
    gatewayData.paymentLink ||
    '';

  /*
   * Se a Sharpify criou o link,
   * mas não retornou nenhum dado de PIX,
   * devolvemos erro claro.
   */
  if (
    !copyPaste &&
    !qrCode &&
    !paymentLinkUrl
  ) {
    const error = new Error(
      'A Sharpify criou o pagamento, mas não retornou código Pix, QR Code ou link.'
    );

    error.status = 502;

    throw error;
  }

  const finalAmount =
    Number(
      payment?.amount ??
      paymentLink?.pricing?.total ??
      amount
    );

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

      paymentLink:
        paymentLinkUrl || null
    },

    transactionId:
      payment?.id ||
      paymentLink?.id ||
      null,

    status:
      paymentLink?.status ||
      'PENDING',

    amount:
      Math.round(
        finalAmount * 100
      ),

    amountDisplay:
      Number(amount).toLocaleString(
        'pt-BR',
        {
          style: 'currency',
          currency: 'BRL'
        }
      ),

    invoiceUrl:
      paymentLinkUrl || null,

    shortReference:
      paymentLink?.shortReference ||
      null
  };
}

export default async function handler(
  req,
  res
) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message:
        'Método não permitido.'
    });
  }

  try {
    const input =
      req.body &&
      typeof req.body === 'object'
        ? req.body
        : {};

    const amount =
      Number(input.amount);

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

    const data =
      await createSharpify({
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
      normalizeMessage(
        error?.message ||
        error
      );

    const status =
      Number(error?.status) >= 400 &&
      Number(error?.status) <= 599
        ? Number(error.status)
        : 502;

    return res.status(status).json({
      success: false,
      gateway: 'sharpify',
      message
    });
  }
}

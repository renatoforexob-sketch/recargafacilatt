const SHARPIFY_DEFAULT_URL =
  'https://sharpify-pay.com/api/v1/gateway/payment/create-paymnet';

function clean(value) {
  return String(value ?? '').trim();
}

function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function formatBRL(value) {
  return Number(value).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

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

async function createSharpifyPayment({
  amount,
  productName,
  metadata
}) {
  const clientId = clean(
    process.env.SHARPIFY_CLIENT_ID
  );

  const clientSecret = clean(
    process.env.SHARPIFY_CLIENT_SECRET
  );

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

  const apiUrl =
    clean(process.env.SHARPIFY_API_URL) ||
    SHARPIFY_DEFAULT_URL;

  const telefone = onlyDigits(
    metadata?.telefone
  );

  const operadora = clean(
    metadata?.operadora
  );

  /*
   * Nome interno do pagamento.
   *
   * Exemplo:
   * Recarga Fácil - Recarga TIM
   */
  const name =
    `Recarga Fácil - Recarga ${
      operadora || 'Celular'
    }`;

  /*
   * Mantemos na descrição os dados
   * importantes da compra.
   */
  const description = [
    `Produto: ${name}`,
    operadora
      ? `Operadora: ${operadora}`
      : null,
    telefone
      ? `Telefone: ${telefone}`
      : null,
    `Valor: ${formatBRL(amount)}`
  ]
    .filter(Boolean)
    .join(' | ');

  /*
   * Payload exatamente conforme
   * a documentação do Gateway Sharpify.
   */
  const payload = {
    name,
    description,
    amount: Number(
      Number(amount).toFixed(2)
    ),
    gatewayMethod: 'PIX'
  };

  console.log(
    'SHARPIFY PAYLOAD:',
    JSON.stringify(payload)
  );

  let response;

  try {
    response = await fetch(apiUrl, {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',

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
   * A Sharpify retornou erro.
   */
  if (!response.ok) {
    console.error(
      'SHARPIFY HTTP ERROR:',
      response.status
    );

    console.error(
      'SHARPIFY RESPONSE:',
      JSON.stringify(data)
    );

    const apiError =
      data?.message ||
      data?.error ||
      data?.detail ||
      data?.raw ||
      `HTTP ${response.status}`;

    const error = new Error(
      `Sharpify HTTP ${response.status}: ${normalizeMessage(
        apiError
      )}`
    );

    error.status =
      response.status;

    throw error;
  }

  /*
   * A documentação informa:
   *
   * { data: PaymentLinkProps }
   */
  const paymentLink =
    data?.data;

  if (
    !paymentLink ||
    typeof paymentLink !== 'object'
  ) {
    console.error(
      'SHARPIFY RESPONSE SEM DATA:',
      JSON.stringify(data)
    );

    const error = new Error(
      'A Sharpify respondeu sem os dados do pagamento.'
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
   * Código PIX copia e cola.
   */
  const copyPaste =
    clean(gatewayData.code);

  /*
   * QR Code retornado pela Sharpify.
   */
  const qrCode =
    clean(gatewayData.qrCode);

  /*
   * Link externo de pagamento,
   * caso exista.
   */
  const paymentLinkUrl =
    clean(gatewayData.paymentLink);

  /*
   * A resposta precisa trazer pelo
   * menos uma forma de pagamento.
   */
  if (
    !copyPaste &&
    !qrCode &&
    !paymentLinkUrl
  ) {
    console.error(
      'SHARPIFY SEM DADOS DE PAGAMENTO:',
      JSON.stringify(data)
    );

    const error = new Error(
      'A Sharpify criou o pagamento, mas não retornou código PIX, QR Code ou link.'
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

    transactionId:
      payment?.id ||
      paymentLink?.id ||
      null,

    paymentLinkId:
      paymentLink?.id ||
      null,

    shortReference:
      paymentLink?.shortReference ||
      null,

    status:
      paymentLink?.status ||
      'PENDING',

    amount:
      Math.round(
        finalAmount * 100
      ),

    amountDisplay:
      formatBRL(finalAmount),

    paymentData: {
      copyPaste:
        copyPaste || null,

      qrCode:
        qrCode || null,

      qrCodeBase64:
        qrCode.startsWith(
          'data:image/'
        )
          ? qrCode
          : null,

      paymentLink:
        paymentLinkUrl || null
    },

    invoiceUrl:
      paymentLinkUrl || null
  };
}

export default async function handler(
  req,
  res
) {
  /*
   * Somente POST.
   */
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      gateway: 'sharpify',
      message:
        'Método não permitido.'
    });
  }

  try {
    const body =
      req.body &&
      typeof req.body === 'object'
        ? req.body
        : {};

    const amount =
      Number(body.amount);

    /*
     * Validação do valor.
     */
    if (
      !Number.isFinite(amount) ||
      amount < 0.01 ||
      amount > 1000
    ) {
      return res.status(400).json({
        success: false,
        gateway: 'sharpify',
        message:
          'O valor da recarga deve estar entre R$ 0,01 e R$ 1.000,00.'
      });
    }

    const metadata =
      body.metadata &&
      typeof body.metadata === 'object'
        ? body.metadata
        : {};

    const productName =
      clean(body.product_name) ||
      `Recarga ${
        clean(metadata.operadora) ||
        'Celular'
      }`;

    const payment =
      await createSharpifyPayment({
        amount,
        productName,
        metadata
      });

    return res.status(200).json({
      success: true,
      gateway: 'sharpify',
      data: payment
    });

  } catch (error) {
    console.error(
      'ERRO SHARPIFY:',
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
      message:
        normalizeMessage(
          error?.message ||
          error
        )
    });
  }
}

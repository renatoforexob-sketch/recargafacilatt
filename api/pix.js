const SHARPIFY_DEFAULT_URL =
  'https://sharpify-pay.com/api/v1/gateway/payment/create-paymnet';

function normalizeErrorMessage(value) {
  if (!value) {
    return 'Não foi possível gerar o pagamento.';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value?.message) {
    return normalizeErrorMessage(value.message);
  }

  if (value?.error) {
    return normalizeErrorMessage(value.error);
  }

  if (value?.detail) {
    return normalizeErrorMessage(value.detail);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return 'Erro inesperado retornado pela Sharpify.';
  }
}

function getString(value) {
  return String(value ?? '').trim();
}

function getAmountInCents(amount) {
  return Math.round(Number(amount) * 100);
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
      'SHARPIFY_CLIENT_ID não está configurado na Vercel.'
    );

    error.status = 500;

    throw error;
  }

  if (!clientSecret) {
    const error = new Error(
      'SHARPIFY_CLIENT_SECRET não está configurado na Vercel.'
    );

    error.status = 500;

    throw error;
  }

  const url =
    process.env.SHARPIFY_API_URL ||
    SHARPIFY_DEFAULT_URL;

  /*
   * Dados recebidos do site
   */
  const telefone = getString(
    metadata?.telefone
  );

  const operadora = getString(
    metadata?.operadora
  );

  const productName = getString(
    input?.product_name
  );

  /*
   * Nome enviado para a Sharpify
   */
  const name =
    productName ||
    `Recarga ${operadora || 'Celular'}`;

  /*
   * Descrição enviada para a Sharpify.
   * Aqui ficam operadora e telefone.
   */
  const description =
    [
      'Recarga de celular',
      operadora
        ? `Operadora: ${operadora}`
        : null,
      telefone
        ? `Telefone: ${telefone}`
        : null
    ]
      .filter(Boolean)
      .join(' - ');

  /*
   * Payload do Gateway Sharpify
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
  } catch (networkError) {
    const error = new Error(
      `Não foi possível conectar à API Sharpify: ${
        networkError?.message ||
        'erro de conexão'
      }`
    );

    error.status = 502;

    throw error;
  }

  /*
   * Lê a resposta como texto primeiro.
   * Isso evita quebrar quando a API devolver
   * HTML ou uma resposta que não seja JSON.
   */
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
   * Erro HTTP da Sharpify
   */
  if (!response.ok) {
    const message =
      normalizeErrorMessage(
        data?.message ||
          data?.error ||
          data?.detail ||
          data?.raw
      );

    const error = new Error(
      `Sharpify HTTP ${response.status}: ${message}`
    );

    error.status =
      response.status || 502;

    throw error;
  }

  /*
   * Algumas APIs retornam:
   *
   * {
   *   success: true,
   *   data: {...}
   * }
   *
   * Outras podem retornar diretamente os dados.
   */
  const paymentData =
    data?.data ||
    data?.payment ||
    data;

  if (
    !paymentData ||
    typeof paymentData !== 'object'
  ) {
    const error = new Error(
      'A Sharpify respondeu sem os dados do pagamento.'
    );

    error.status = 502;

    throw error;
  }

  /*
   * Estrutura documentada do pagamento
   */
  const payment =
    paymentData?.payment ||
    {};

  const gateway =
    payment?.gateway ||
    {};

  const gatewayData =
    gateway?.data ||
    paymentData?.gateway?.data ||
    {};

  /*
   * Código PIX
   */
  const copyPaste =
    gatewayData?.code ||
    gatewayData?.copyPaste ||
    gatewayData?.pixCode ||
    paymentData?.code ||
    paymentData?.copyPaste ||
    paymentData?.pixCode ||
    '';

  /*
   * QR Code
   */
  const qrCode =
    gatewayData?.qrCode ||
    gatewayData?.qrCodeBase64 ||
    paymentData?.qrCode ||
    paymentData?.qrCodeBase64 ||
    '';

  /*
   * Link de pagamento
   */
  const paymentLink =
    gatewayData?.paymentLink ||
    paymentData?.paymentLink ||
    paymentData?.url ||
    null;

  /*
   * ID da transação
   */
  const transactionId =
    paymentData?.id ||
    payment?.id ||
    paymentData?.transactionId ||
    paymentData?.transaction_id ||
    null;

  /*
   * Status
   */
  const status =
    paymentData?.status ||
    payment?.status ||
    'PENDING';

  /*
   * Se não veio nenhum código PIX
   * e também não veio QR/link,
   * consideramos resposta inválida.
   */
  if (
    !copyPaste &&
    !qrCode &&
    !paymentLink
  ) {
    const apiMessage =
      normalizeErrorMessage(
        data?.message ||
          data?.error
      );

    const error = new Error(
      apiMessage !==
        'Não foi possível gerar o pagamento.'
        ? apiMessage
        : 'A Sharpify criou a solicitação, mas não retornou código Pix, QR Code ou link de pagamento.'
    );

    error.status = 502;

    throw error;
  }

  /*
   * Valor retornado pela Sharpify.
   * Se não existir, usamos o valor enviado.
   */
  const returnedAmount =
    Number(
      payment?.amount ??
        paymentData?.amount ??
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

      paymentLink
    },

    transactionId,

    status,

    amount:
      Number.isFinite(returnedAmount)
        ? getAmountInCents(
            returnedAmount
          )
        : getAmountInCents(amount),

    amountDisplay:
      Number(amount).toLocaleString(
        'pt-BR',
        {
          style: 'currency',
          currency: 'BRL'
        }
      ),

    invoiceUrl:
      paymentLink,

    shortReference:
      paymentData?.shortReference ||
      paymentData?.reference ||
      null,

    customer: {
      name:
        paymentData?.customer?.name ||
        null,

      phone:
        telefone || null,

      operator:
        operadora || null
    }
  };
}

export default async function handler(
  req,
  res
) {
  /*
   * Somente POST
   */
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

    /*
     * Valor
     */
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

    /*
     * Metadata enviada pelo frontend
     */
    const metadata =
      input.metadata &&
      typeof input.metadata === 'object'
        ? input.metadata
        : {};

    /*
     * Nome do produto
     */
    const productName =
      getString(
        input.product_name
      );

    /*
     * Garante que o gateway usado
     * é Sharpify.
     *
     * Blackcat não participa mais
     * deste arquivo.
     */
    const data =
      await createSharpify({
        amount,
        input: {
          ...input,
          product_name:
            productName ||
            `Recarga ${
              metadata?.operadora ||
              'Celular'
            }`
        },
        metadata
      });

    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    const message =
      normalizeErrorMessage(
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

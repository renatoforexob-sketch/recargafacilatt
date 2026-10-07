const SHARPIFY_DEFAULT_URL =
  'https://sharpify-pay.com/api/v1/gateway/payment/create-paymnet';

function getMessage(value) {
  if (!value) {
    return 'Erro desconhecido retornado pela Sharpify.';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value.message) {
    return getMessage(value.message);
  }

  if (value.error) {
    return getMessage(value.error);
  }

  if (value.detail) {
    return getMessage(value.detail);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return 'Erro desconhecido retornado pela Sharpify.';
  }
}

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function text(value) {
  return String(value ?? '').trim();
}

async function criarPagamentoSharpify({
  amount,
  productName,
  metadata
}) {
  const clientId = text(
    process.env.SHARPIFY_CLIENT_ID
  );

  const clientSecret = text(
    process.env.SHARPIFY_CLIENT_SECRET
  );

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

  const apiUrl =
    text(process.env.SHARPIFY_API_URL) ||
    SHARPIFY_DEFAULT_URL;

  const telefone = digits(
    metadata?.telefone
  );

  const operadora = text(
    metadata?.operadora
  );

  /*
   * A Sharpify exige:
   *
   * name
   * amount
   * gatewayMethod
   *
   * description é opcional.
   */

  const name =
    text(productName) ||
    `Recarga ${operadora || 'Celular'}`;

  const description = [
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
   * Payload exatamente conforme
   * a documentação oficial da Sharpify.
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
      `Não foi possível conectar à Sharpify: ${
        err?.message ||
        'erro de conexão'
      }`
    );

    error.status = 502;

    throw error;
  }

  const raw = await response.text();

  let result;

  try {
    result = raw
      ? JSON.parse(raw)
      : {};
  } catch {
    result = {
      raw
    };
  }

  /*
   * Se a Sharpify devolver erro,
   * preservamos a resposta para diagnóstico.
   */
  if (!response.ok) {
    const sharpifyMessage =
      result?.message ||
      result?.error ||
      result?.detail ||
      result?.raw ||
      `HTTP ${response.status}`;

    const error = new Error(
      `Sharpify HTTP ${response.status}: ${getMessage(
        sharpifyMessage
      )}`
    );

    error.status = response.status;

    /*
     * Informações seguras para diagnóstico.
     * NÃO retornamos clientSecret.
     */
    error.sharpifyResponse = result;
    error.sharpifyPayload = payload;

    throw error;
  }

  /*
   * A documentação informa:
   *
   * { data: PaymentLinkProps }
   */
  const paymentLink = result?.data;

  if (
    !paymentLink ||
    typeof paymentLink !== 'object'
  ) {
    const error = new Error(
      'A Sharpify respondeu sem o objeto data do pagamento.'
    );

    error.status = 502;
    error.sharpifyResponse = result;

    throw error;
  }

  const payment =
    paymentLink.payment || null;

  const gateway =
    payment?.gateway || null;

  const gatewayData =
    gateway?.data || {};

  const copyPaste =
    text(gatewayData.code);

  const qrCode =
    text(gatewayData.qrCode);

  const paymentLinkUrl =
    text(gatewayData.paymentLink);

  /*
   * Precisamos de pelo menos um
   * dos dados necessários para pagar.
   */
  if (
    !copyPaste &&
    !qrCode &&
    !paymentLinkUrl
  ) {
    const error = new Error(
      'A Sharpify criou o pagamento, mas não retornou código PIX, QR Code ou link de pagamento.'
    );

    error.status = 502;
    error.sharpifyResponse = result;

    throw error;
  }

  const finalAmount = Number(
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

    shortReference:
      paymentLink?.shortReference ||
      null,

    status:
      paymentLink?.status ||
      'PENDING',

    amount: Math.round(
      finalAmount * 100
    ),

    amountDisplay:
      Number(finalAmount).toLocaleString(
        'pt-BR',
        {
          style: 'currency',
          currency: 'BRL'
        }
      ),

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
      text(body.product_name) ||
      `Recarga ${
        text(metadata.operadora) ||
        'Celular'
      }`;

    const payment =
      await criarPagamentoSharpify({
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
      error?.message
    );

    /*
     * Mostra no log da Vercel a resposta
     * real da Sharpify, sem mostrar segredo.
     */
    if (error?.sharpifyResponse) {
      console.error(
        'RESPOSTA SHARPIFY:',
        JSON.stringify(
          error.sharpifyResponse
        )
      );
    }

    if (error?.sharpifyPayload) {
      console.error(
        'PAYLOAD ENVIADO:',
        JSON.stringify(
          error.sharpifyPayload
        )
      );
    }

    const status =
      Number(error?.status) >= 400 &&
      Number(error?.status) <= 599
        ? Number(error.status)
        : 502;

    return res.status(status).json({
      success: false,
      gateway: 'sharpify',
      message:
        getMessage(
          error?.message ||
          error
        )
    });
  }
}

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
    return 'Erro desconhecido retornado pela Sharpify.';
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

/*
|--------------------------------------------------------------------------
| WEBHOOK URL
|--------------------------------------------------------------------------
*/

function getWebhookUrl(req) {
  /*
   * Se você colocar SHARPIFY_WEBHOOK_URL na Vercel,
   * ela terá prioridade.
   */
  const configured =
    clean(process.env.SHARPIFY_WEBHOOK_URL);

  if (configured) {
    return configured;
  }

  /*
   * Caso não exista variável,
   * tenta montar automaticamente.
   */
  const host =
    clean(
      req?.headers?.['x-forwarded-host']
    ) ||
    clean(
      req?.headers?.host
    );

  if (!host) {
    return null;
  }

  const protocol =
    clean(
      req?.headers?.['x-forwarded-proto']
    ) ||
    'https';

  return `${protocol}://${host}/api/pix`;
}

/*
|--------------------------------------------------------------------------
| CRIAR PAGAMENTO SHARPIFY
|--------------------------------------------------------------------------
*/

async function createSharpifyPayment({
  amount,
  metadata,
  req
}) {
  const clientId =
    clean(
      process.env.SHARPIFY_CLIENT_ID
    );

  const clientSecret =
    clean(
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
    clean(
      process.env.SHARPIFY_API_URL
    ) ||
    SHARPIFY_DEFAULT_URL;

  const telefone =
    onlyDigits(
      metadata?.telefone
    );

  const operadora =
    clean(
      metadata?.operadora
    );

  /*
   * Nome da venda dentro da Sharpify.
   *
   * Exemplo:
   * Recarga Fácil - Recarga TIM
   */
  const name =
    `Recarga Fácil - Recarga ${
      operadora || 'Celular'
    }`;

  /*
   * Informações da compra.
   */
  const description = [
    `Operadora: ${
      operadora || 'Não informada'
    }`,

    telefone
      ? `Telefone: ${telefone}`
      : null,

    `Valor: ${formatBRL(amount)}`
  ]
    .filter(Boolean)
    .join(' | ');

  /*
   * URL que receberá os eventos da Sharpify.
   */
  const webhookURL =
    getWebhookUrl(req);

  /*
   * Payload oficial do Gateway Sharpify.
   */
  const payload = {
    name,
    description,
    amount: Number(
      Number(amount).toFixed(2)
    ),
    gatewayMethod: 'PIX'
  };

  /*
   * Adiciona webhook ao pagamento.
   */
  if (webhookURL) {
    payload.webhook = {
      callbackURL: webhookURL
    };
  }

  console.log(
    'SHARPIFY PAYMENT PAYLOAD:',
    JSON.stringify(payload)
  );

  let response;

  try {
    response = await fetch(
      apiUrl,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          'x-sharpify-client-id':
            clientId,

          'x-sharpify-client-secret':
            clientSecret
        },

        body:
          JSON.stringify(payload)
      }
    );
  } catch (error) {
    const connectionError =
      new Error(
        `Falha de conexão com a Sharpify: ${
          error?.message ||
          'erro desconhecido'
        }`
      );

    connectionError.status = 502;

    throw connectionError;
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
   * Erro retornado pela Sharpify.
   */
  if (!response.ok) {
    console.error(
      'SHARPIFY HTTP:',
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

    const error =
      new Error(
        `Sharpify HTTP ${response.status}: ${normalizeMessage(
          apiError
        )}`
      );

    error.status =
      response.status;

    throw error;
  }

  /*
   * Resposta esperada:
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
    console.error(
      'SHARPIFY RESPONSE:',
      JSON.stringify(data)
    );

    const error =
      new Error(
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
   * PIX copia e cola.
   */
  const copyPaste =
    clean(
      gatewayData.code
    );

  /*
   * QR Code.
   */
  const qrCode =
    clean(
      gatewayData.qrCode
    );

  /*
   * Link externo.
   */
  const paymentLinkUrl =
    clean(
      gatewayData.paymentLink
    );

  /*
   * Verifica se a Sharpify retornou
   * alguma forma de pagamento.
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

    const error =
      new Error(
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

    paymentLinkId:
      paymentLink?.id ||
      null,

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

/*
|--------------------------------------------------------------------------
| RECEBER WEBHOOK SHARPIFY
|--------------------------------------------------------------------------
*/

async function handleSharpifyWebhook(
  req,
  res
) {
  const body =
    req.body &&
    typeof req.body === 'object'
      ? req.body
      : null;

  if (!body) {
    return res.status(400).json({
      success: false,
      message:
        'Webhook inválido.'
    });
  }

  const event =
    body.event || {};

  const eventName =
    clean(event.name);

  const webhookId =
    clean(event.webhookId);

  const eventId =
    clean(event.id);

  const context =
    clean(event.context);

  const contextId =
    clean(event.contextId);

  const occurredAt =
    clean(event.occurredAt);

  const paymentLink =
    body?.data?.paymentLink ||
    {};

  /*
   * Log do webhook.
   *
   * Não registramos credenciais.
   */
  console.log(
    'SHARPIFY WEBHOOK:',
    JSON.stringify({
      schemaVersion:
        body.schemaVersion ||
        null,

      eventId:
        eventId ||
        null,

      webhookId:
        webhookId ||
        null,

      eventName:
        eventName ||
        null,

      context:
        context ||
        null,

      contextId:
        contextId ||
        null,

      occurredAt:
        occurredAt ||
        null,

      paymentLinkId:
        paymentLink.id ||
        null,

      shortReference:
        paymentLink.shortReference ||
        null,

      status:
        paymentLink.status ||
        null,

      paymentId:
        paymentLink?.payment?.id ||
        null,

      amount:
        paymentLink?.payment?.amount ??
        paymentLink?.pricing?.total ??
        null,

      name:
        paymentLink.name ||
        null
    })
  );

  /*
   * PAGAMENTO APROVADO
   */
  if (
    eventName ===
    'PAYMENT_LINK_APPROVED'
  ) {
    console.log(
      'SHARPIFY: PAGAMENTO APROVADO',
      JSON.stringify({
        webhookId,
        paymentLinkId:
          paymentLink.id ||
          contextId ||
          null,

        paymentId:
          paymentLink?.payment?.id ||
          null,

        amount:
          paymentLink?.payment?.amount ??
          paymentLink?.pricing?.total ??
          null
      })
    );

    /*
     * Aqui é o ponto onde o sistema
     * considera o pagamento aprovado.
     *
     * Futuramente pode executar:
     *
     * - registrar venda;
     * - liberar recarga;
     * - atualizar painel;
     * - registrar conversão.
     */
  }

  /*
   * PAGAMENTO CANCELADO
   */
  if (
    eventName ===
    'PAYMENT_LINK_CANCELLED'
  ) {
    console.log(
      'SHARPIFY: PAGAMENTO CANCELADO',
      JSON.stringify({
        webhookId,
        paymentLinkId:
          paymentLink.id ||
          contextId ||
          null
      })
    );
  }

  /*
   * A Sharpify espera resposta 2xx.
   */
  return res.status(200).json({
    success: true,
    received: true,
    webhookId:
      webhookId ||
      null,
    event:
      eventName ||
      null
  });
}

/*
|--------------------------------------------------------------------------
| HANDLER PRINCIPAL
|--------------------------------------------------------------------------
*/

export default async function handler(
  req,
  res
) {
  /*
   * O mesmo endpoint:
   *
   * POST /api/pix
   *
   * também recebe:
   *
   * POST /api/pix
   * com webhook da Sharpify.
   *
   * Identificamos pelo formato da requisição.
   */

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      gateway: 'sharpify',
      message:
        'Método não permitido.'
    });
  }

  /*
   * Se vier no formato de webhook,
   * processa o webhook.
   *
   * A Sharpify envia "event".
   */
  if (
    req.body &&
    typeof req.body === 'object' &&
    req.body.event &&
    (
      req.body.event.name ===
        'PAYMENT_LINK_APPROVED' ||
      req.body.event.name ===
        'PAYMENT_LINK_CANCELLED'
    )
  ) {
    try {
      return await handleSharpifyWebhook(
        req,
        res
      );
    } catch (error) {
      console.error(
        'ERRO WEBHOOK SHARPIFY:',
        error?.message ||
        error
      );

      return res.status(500).json({
        success: false,
        message:
          'Erro ao processar webhook.'
      });
    }
  }

  /*
   * Caso contrário, é uma criação
   * normal de pagamento.
   */
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

    const payment =
      await createSharpifyPayment({
        amount,
        metadata,
        req
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

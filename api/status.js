```javascript
const SHARPIFY_STATUS_URL =
  'https://sharpify-pay.com/api/v1/gateway/payment/get-payment';

function clean(value) {
  return String(value ?? '').trim();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Método não permitido.'
    });
  }

  const clientId = clean(process.env.SHARPIFY_CLIENT_ID);
  const clientSecret = clean(process.env.SHARPIFY_CLIENT_SECRET);

  if (!clientId || !clientSecret) {
    return res.status(500).json({
      success: false,
      gateway: 'sharpify',
      message:
        'Configure SHARPIFY_CLIENT_ID e SHARPIFY_CLIENT_SECRET nas variáveis de ambiente da Vercel.'
    });
  }

  // Aceita o identificador do link de pagamento retornado
  // pela criação do pagamento na Sharpify.
  const paymentLinkId = clean(req.query?.paymentLinkId);

  if (!paymentLinkId) {
    return res.status(400).json({
      success: false,
      gateway: 'sharpify',
      message: 'paymentLinkId é obrigatório.'
    });
  }

  try {
    const url = new URL(SHARPIFY_STATUS_URL);
    url.searchParams.set('paymentLinkId', paymentLinkId);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-sharpify-client-id': clientId,
        'x-sharpify-client-secret': clientSecret,
        'Content-Type': 'application/json'
      }
    });

    const responseText = await response.text();

    let data;

    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = {
        message: 'A Sharpify retornou uma resposta inválida.'
      };
    }

    return res.status(response.status).json(data);
  } catch (error) {
    console.error(
      'Erro ao consultar pagamento Sharpify:',
      error?.message || 'Erro desconhecido'
    );

    return res.status(502).json({
      success: false,
      gateway: 'sharpify',
      message: 'Não foi possível consultar o status do pagamento.'
    });
  }
}
```

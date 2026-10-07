const STATUS_BASE_URL = process.env.BLACKCAT_STATUS_URL || 'https://api.blackcatpay.com.br/api/sales';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Método não permitido' });
  if (!process.env.BLACKCAT_API_KEY) return res.status(500).json({ success: false, message: 'BLACKCAT_API_KEY não configurada no ambiente da Vercel.' });
  const transaction = String(req.query?.transaction || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!transaction) return res.status(400).json({ success: false, message: 'transaction é obrigatória.' });
  try {
    const response = await fetch(`${STATUS_BASE_URL}/${encodeURIComponent(transaction)}/status`, { headers: { 'X-API-Key': process.env.BLACKCAT_API_KEY, 'Content-Type': 'application/json' } });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch {
    return res.status(502).json({ success: false, message: 'Não foi possível consultar o status do pagamento.' });
  }
}

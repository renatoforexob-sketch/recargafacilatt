
const response = await fetch('/api/pix', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    gateway: 'sharpify',
    amount,
    product_name: `Recarga ${operator.name} ${money(amount)}`,
    metadata: {
      telefone: onlyDigits(saved.phone),
      operadora: operator.name
    }
  })
});

const data = await response.json().catch(() => ({}));

if (!response.ok || !data.success) {
  throw new Error(
    typeof data.message === 'string'
      ? data.message
      : 'Não foi possível gerar o Pix.'
  );
}

if (!data.data) {
  throw new Error(
    'A Sharpify não retornou os dados do pagamento.'
  );
}

setPix(data.data);

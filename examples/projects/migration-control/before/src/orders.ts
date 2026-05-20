export function submitOrder(input: { total: number }) {
  return oldApi(input);
}

function oldApi(input: { total: number }) {
  return { ok: true, total: input.total };
}

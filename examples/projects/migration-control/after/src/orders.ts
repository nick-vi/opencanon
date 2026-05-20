export function submitOrder(input: { total: number }) {
  return currentApi(input);
}

function currentApi(input: { total: number }) {
  return { ok: true, total: input.total };
}

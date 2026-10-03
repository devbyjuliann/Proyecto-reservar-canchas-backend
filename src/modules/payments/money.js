// Reserva's COP minor unit is a cent; Wompi uses that exact same integer.
export function wompiAmountInCentsFromMinor(amountMinor) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) throw new TypeError('amountMinor must be positive');
  return amountMinor;
}

export function copToMinor(cop) {
  if (!Number.isSafeInteger(cop) || cop < 0) throw new TypeError('COP must be a non-negative integer');
  return cop * 100;
}

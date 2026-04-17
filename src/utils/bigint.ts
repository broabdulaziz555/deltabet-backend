// Patch BigInt to serialize as string in JSON
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export function parseBigInt(value: string | number): bigint {
  return BigInt(value);
}

export function safeNumber(value: bigint): number {
  return Number(value);
}

export function maskUsername(username: string): string {
  if (username.length <= 2) return username[0] + '*';
  if (username.length <= 4) return username[0] + '**' + username[username.length - 1];
  return username[0] + '***' + username[username.length - 1];
}

export function formatUZS(amount: bigint | number): string {
  const num = typeof amount === 'bigint' ? Number(amount) : amount;
  return new Intl.NumberFormat('uz-UZ').format(num) + " so'm";
}

export function getClientIp(req: any): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

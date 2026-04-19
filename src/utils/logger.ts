type Level = 'debug' | 'info' | 'warn' | 'error';

function log(level: Level, message: string, meta?: Record<string, unknown>) {
  const entry = {
    ts:      new Date().toISOString(),
    level,
    message,
    ...(meta ?? {}),
  };
  const str = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(str + '\n');
  } else {
    process.stdout.write(str + '\n');
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => log('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => log('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
};

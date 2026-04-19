import { Lang } from '../../config/constants';

export type { Lang };

const T: Record<string, Record<Lang, string>> = {
  insufficientBalance: {
    en: 'Insufficient balance',
    ru: 'Недостаточно средств',
    uz: "Mablag' yetarli emas",
  },
  betPhaseOver: {
    en: 'Betting phase has ended',
    ru: 'Фаза ставок завершена',
    uz: "Garov qo'yish fazasi tugadi",
  },
  alreadyBet: {
    en: 'You already have an active bet on this table',
    ru: 'У вас уже есть активная ставка за этим столом',
    uz: 'Ushbu stolda faol stavkangiz mavjud',
  },
  noBet: {
    en: 'No active bet found',
    ru: 'Активная ставка не найдена',
    uz: "Faol stavka topilmadi",
  },
  notFlying: {
    en: 'Game is not in flying phase',
    ru: 'Игра не в фазе полёта',
    uz: "O'yin uchish fazasida emas",
  },
  invalidPromo: {
    en: 'Invalid or expired promo code',
    ru: 'Недействительный или просроченный промокод',
    uz: "Noto'g'ri yoki muddati o'tgan promo-kod",
  },
  promoAlreadyUsed: {
    en: 'You have already used this promo code',
    ru: 'Вы уже использовали этот промокод',
    uz: 'Siz ushbu promo-kodni allaqachon ishlatgansiz',
  },
  userBanned: {
    en: 'Your account has been suspended',
    ru: 'Ваш аккаунт заблокирован',
    uz: "Hisobingiz bloklangan",
  },
  invalidCredentials: {
    en: 'Invalid username or password',
    ru: 'Неверное имя пользователя или пароль',
    uz: "Noto'g'ri foydalanuvchi nomi yoki parol",
  },
  usernameExists: {
    en: 'Username already taken',
    ru: 'Имя пользователя уже занято',
    uz: 'Foydalanuvchi nomi band',
  },
  minDeposit: {
    en: 'Minimum deposit is 10,000 soums',
    ru: 'Минимальный депозит — 10 000 сум',
    uz: "Minimal depozit — 10 000 so'm",
  },
  minWithdrawal: {
    en: 'Minimum withdrawal is 50,000 soums',
    ru: 'Минимальный вывод — 50 000 сум',
    uz: "Minimal yechib olish — 50 000 so'm",
  },
  unauthorized: {
    en: 'Unauthorized',
    ru: 'Не авторизован',
    uz: 'Ruxsat berilmagan',
  },
  notFound: {
    en: 'Not found',
    ru: 'Не найдено',
    uz: 'Topilmadi',
  },
  betTooSmall: {
    en: 'Minimum bet is 2,000 soums',
    ru: 'Минимальная ставка — 2 000 сум',
    uz: "Minimal stavka — 2 000 so'm",
  },
  betTooLarge: {
    en: 'Maximum bet is 5,000,000 soums',
    ru: 'Максимальная ставка — 5 000 000 сум',
    uz: "Maksimal stavka — 5 000 000 so'm",
  },
};

export function t(key: string, lang: Lang = 'ru'): string {
  return T[key]?.[lang] ?? T[key]?.['en'] ?? key;
}

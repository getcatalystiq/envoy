export function normalizePhone(phone: string | null): string | null {
  if (!phone) return null;

  phone = phone.trim();
  if (!phone) return null;

  const hasPlus = phone.startsWith("+");
  const digits = phone.replace(/\D/g, "");

  if (!digits || digits.length < 7) return null;
  if (digits.length > 15) return null;

  if (hasPlus) {
    return `+${digits}`;
  } else if (digits.startsWith("1") && digits.length === 11) {
    return `+${digits}`;
  } else if (digits.length === 10) {
    return `+1${digits}`;
  } else {
    return `+${digits}`;
  }
}

export function phonesMatch(
  phone1: string | null,
  phone2: string | null,
): boolean {
  const norm1 = normalizePhone(phone1);
  const norm2 = normalizePhone(phone2);

  if (norm1 === null || norm2 === null) return false;
  return norm1 === norm2;
}

export function formatPhoneDisplay(phone: string | null): string | null {
  if (!phone) return null;

  const normalized = normalizePhone(phone);
  if (!normalized) return phone;

  const digits = normalized.replace(/^\+/, "");

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.substring(1, 4)}) ${digits.substring(4, 7)}-${digits.substring(7)}`;
  }

  if (digits.length === 10) {
    return `(${digits.substring(0, 3)}) ${digits.substring(3, 6)}-${digits.substring(6)}`;
  }

  return normalized;
}

const EMAIL = /^\S+@\S+\.\S+$/;

export const isValidEmail = (value: string) => EMAIL.test(value.trim());

export const isValidIdentifier = (value: string) => {
  const text = value.trim();
  return text.includes('@') ? isValidEmail(text) : text.length >= 3;
};

export const isValidUsername = (value: string) => value.trim().length >= 3;

/** Same rule as the API (contracts `Password`). */
export const isValidPassword = (value: string) => value.length >= 8;

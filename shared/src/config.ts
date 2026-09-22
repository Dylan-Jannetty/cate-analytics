/**
 * Central config module. TOKEN_MINT is read here and ONLY here.
 * All pipeline scripts and site code must import `config` from this module
 * rather than reading process.env.TOKEN_MINT directly.
 */

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  get tokenMint(): string {
    return requireEnv("TOKEN_MINT");
  },
  get heliusApiKey(): string {
    return requireEnv("HELIUS_API_KEY");
  },
  get ownerEmail(): string {
    return requireEnv("OWNER_EMAIL");
  },
} as const;

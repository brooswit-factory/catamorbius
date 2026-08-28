/**
 * Throwaway HMAC key used ONLY inside test fixtures — not a real webhook
 * secret, safe to commit (per KAN-739: "A throwaway HMAC key used ONLY
 * inside test fixtures is NOT a secret and may be committed").
 */
export const TEST_SECRET = "whsec_test_fixture_do_not_use_in_prod_5f1a9c";

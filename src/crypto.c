/* The tunnel's crypto as picotls is given it: each algorithm's description in picotls's own structures, compiled here
 * so their layout is the C compiler's for each target, its work done by the tunnel's Zig on std.crypto
 * (src/crypto.zig); and picoquic's baseline provider, which picoquic loads by its name as it first makes a TLS context,
 * picoquic being compiled with no provider of its own. */
#include "picotls.h"
#include "picoquic.h"
#include "picoquic_crypto_provider_api.h"
#include "crypto.h"

static ptls_hash_algorithm_t sha256 = {"sha256", PTLS_SHA256_BLOCK_SIZE, PTLS_SHA256_DIGEST_SIZE, octoii_tunnel_sha256_create,
                                       PTLS_ZERO_DIGEST_SHA256};

static ptls_cipher_algorithm_t aes128ctr = {"AES128-CTR", PTLS_AES128_KEY_SIZE, 1, PTLS_AES_IV_SIZE,
                                            sizeof(struct octoii_tunnel_stream_cipher), octoii_tunnel_stream_cipher_setup_aes128};

static ptls_cipher_algorithm_t chacha20 = {"CHACHA20", PTLS_CHACHA20_KEY_SIZE, 1, PTLS_CHACHA20_IV_SIZE,
                                           sizeof(struct octoii_tunnel_stream_cipher), octoii_tunnel_stream_cipher_setup_chacha20};

static ptls_aead_algorithm_t aes128gcm = {"AES128-GCM",
                                          PTLS_AESGCM_CONFIDENTIALITY_LIMIT,
                                          PTLS_AESGCM_INTEGRITY_LIMIT,
                                          &aes128ctr,
                                          NULL,
                                          PTLS_AES128_KEY_SIZE,
                                          PTLS_AESGCM_IV_SIZE,
                                          PTLS_AESGCM_TAG_SIZE,
                                          {PTLS_TLS12_AESGCM_FIXED_IV_SIZE, PTLS_TLS12_AESGCM_RECORD_IV_SIZE},
                                          0,
                                          0,
                                          sizeof(struct octoii_tunnel_aead),
                                          octoii_tunnel_aead_setup_aes128gcm};

static ptls_aead_algorithm_t chacha20poly1305 = {"CHACHA20-POLY1305",
                                                 PTLS_CHACHA20POLY1305_CONFIDENTIALITY_LIMIT,
                                                 PTLS_CHACHA20POLY1305_INTEGRITY_LIMIT,
                                                 &chacha20,
                                                 NULL,
                                                 PTLS_CHACHA20_KEY_SIZE,
                                                 PTLS_CHACHA20POLY1305_IV_SIZE,
                                                 PTLS_CHACHA20POLY1305_TAG_SIZE,
                                                 {PTLS_TLS12_CHACHAPOLY_FIXED_IV_SIZE, PTLS_TLS12_CHACHAPOLY_RECORD_IV_SIZE},
                                                 0,
                                                 0,
                                                 sizeof(struct octoii_tunnel_aead),
                                                 octoii_tunnel_aead_setup_chacha20poly1305};

static ptls_cipher_suite_t aes128gcmsha256 = {.id = PTLS_CIPHER_SUITE_AES_128_GCM_SHA256,
                                              .aead = &aes128gcm,
                                              .hash = &sha256,
                                              .name = PTLS_CIPHER_SUITE_NAME_AES_128_GCM_SHA256};

static ptls_cipher_suite_t chacha20poly1305sha256 = {.id = PTLS_CIPHER_SUITE_CHACHA20_POLY1305_SHA256,
                                                     .aead = &chacha20poly1305,
                                                     .hash = &sha256,
                                                     .name = PTLS_CIPHER_SUITE_NAME_CHACHA20_POLY1305_SHA256};

static ptls_key_exchange_algorithm_t x25519 = {.id = PTLS_GROUP_X25519,
                                               .name = PTLS_GROUP_NAME_X25519,
                                               .create = octoii_tunnel_x25519_create,
                                               .exchange = octoii_tunnel_x25519_exchange};

void picoquic_ptls_minicrypto_load(int unload)
{
    if (unload != 0)
        return;
    picoquic_register_ciphersuite(&aes128gcmsha256);
    picoquic_register_ciphersuite(&chacha20poly1305sha256);
    picoquic_register_key_exchange_algorithm(&x25519);
    picoquic_register_crypto_random_provider_fn(octoii_tunnel_random_bytes);
}

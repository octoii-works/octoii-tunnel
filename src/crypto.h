/* The tunnel's crypto for picotls: the state its stream ciphers and AEADs keep in the contexts picotls allocates for
 * them, and the functions the tunnel's Zig gives on std.crypto (src/crypto.zig), which src/crypto.c names in its
 * descriptions of the algorithms. */
#ifndef OCTOII_TUNNEL_CRYPTO_H
#define OCTOII_TUNNEL_CRYPTO_H

#include "picotls.h"

/* A stream cipher's context, AES-128 in counter mode or ChaCha20, as QUIC protects headers with: its key, the counter
 * block of its next keystream (ChaCha20's: its 32-bit counter, little-endian, then its nonce), and what is left of the
 * keystream it last made. */
struct octoii_tunnel_stream_cipher {
    ptls_cipher_context_t base;
    uint8_t key[32];
    uint8_t counter[16];
    uint8_t keystream[64];
    uint8_t available;
};

/* An AEAD's context, AES-128-GCM or ChaCha20-Poly1305: its key and its static IV. */
struct octoii_tunnel_aead {
    ptls_aead_context_t base;
    uint8_t key[32];
    uint8_t iv[12];
};

int octoii_tunnel_stream_cipher_setup_aes128(ptls_cipher_context_t *ctx, int is_enc, const void *key);
int octoii_tunnel_stream_cipher_setup_chacha20(ptls_cipher_context_t *ctx, int is_enc, const void *key);
int octoii_tunnel_aead_setup_aes128gcm(ptls_aead_context_t *ctx, int is_enc, const void *key, const void *iv);
int octoii_tunnel_aead_setup_chacha20poly1305(ptls_aead_context_t *ctx, int is_enc, const void *key, const void *iv);
ptls_hash_context_t *octoii_tunnel_sha256_create(void);
int octoii_tunnel_x25519_create(ptls_key_exchange_algorithm_t *algo, ptls_key_exchange_context_t **ctx);
int octoii_tunnel_x25519_exchange(ptls_key_exchange_algorithm_t *algo, ptls_iovec_t *pubkey, ptls_iovec_t *secret,
                                  ptls_iovec_t peerkey);
void octoii_tunnel_random_bytes(void *buf, size_t len);

#endif

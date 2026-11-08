/* What picoquic keeps of an endpoint's TLS, which it gives no function of its own to reach: the endpoint's signing, by
 * its identity's key, is set on it here. picoquic frees the signer with the rest of that TLS context. */
#include "picotls.h"
#include "picoquic_internal.h"

void octoii_tunnel_set_signer(picoquic_quic_t *quic, ptls_sign_certificate_t *signer)
{
    ((ptls_context_t *)quic->tls_master_ctx)->sign_certificate = signer;
}

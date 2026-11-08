/* What the tunnel reaches of picoquic and picotls, translated to Zig as the module `quic`. */
#ifdef _WINDOWS
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <netinet/in.h>
#include <sys/socket.h>
#endif

#include "picotls.h"
#include "picoquic.h"
#include "picoquic_crypto_provider_api.h"
#include "picoquic_bbr.h"
#include "picoquic_utils.h"
#include "crypto.h"

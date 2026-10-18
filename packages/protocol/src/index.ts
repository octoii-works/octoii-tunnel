/**
 * The octoiitunnel wire format, shared by the client and the relay: frames and their payloads, the rules of the
 * connector connection, limits, flow control, WebSocket messages, the relay's HTTP API, and the formats of device ids,
 * credentials and addresses. It does no I/O, and runs wherever web standards do, Hermes included.
 */
export {
	devicePath,
	connectPath,
	decodeRegistration,
	type DevicePathMatch,
	ERROR_STATUS,
	type ErrorBody,
	type ErrorCode,
	matchDevicePath,
	MAX_DEVICE_NAME_LENGTH,
	MAX_REGISTRATION_BYTES,
	REGISTRATION_PATH,
	type Registration,
	SECURE_PATH,
} from "./api.ts";
export { decodeBase64Url, encodeBase64Url } from "./base64url.ts";
export {
	CLOSE_CODE,
	FINAL_CLOSE_CODES,
	HELLO_TIMEOUT,
	isResetCode,
	MAX_REASON_LENGTH,
	MISSED_HEARTBEATS,
	PING,
	PONG,
	RESET_CODES,
	type ResetCode,
} from "./connection.ts";
export { IncomingBody, type IncomingBodyEvents, MessageCredit, ReceiveCredit, SendCredit, sendBody } from "./credit.ts";
export { ProtocolError } from "./errors.ts";
export {
	CREDENTIAL_BYTES,
	DEVICE_ID_LENGTH,
	deviceAddress,
	hashCredential,
	isCredential,
	isDeviceId,
	newCredential,
	newDeviceId,
	parseRelayOrigin,
	type RelayOrigin,
	sameSecret,
} from "./formats.ts";
export { decodeFrame, encodeFrame, type Frame, FRAME_HEADER_SIZE, FRAME_TYPE, type FrameType, isFrameType, MAX_FRAME_SIZE, PROTOCOL_VERSION } from "./frame.ts";
export { decodeHeaderList, forwardableHeaders, type HeaderList, isHeaderName, MAX_HEADERS, toHeaders } from "./headers.ts";
export { decodeJsonObject, encodeJson, isIntegerBetween, isJsonObject, isStringUpTo, type JsonObject } from "./json.ts";
export { checkLimits, DEFAULT_LIMITS, LIMIT_RANGES, type Limits, MAX_MESSAGE_SIZE } from "./limits.ts";
export { GOING_AWAY, type Message, MessageAssembler, MessageSender, toClosing } from "./messages.ts";
export {
	type Closing,
	decodeClosing,
	decodeCredit,
	decodeHello,
	decodeHttpHead,
	decodeMessageChunk,
	decodeOpen,
	decodeReset,
	decodeWebSocketHead,
	decodeWelcome,
	encodeClosing,
	encodeCredit,
	encodeHello,
	encodeHttpHead,
	encodeMessageChunk,
	encodeOpen,
	encodeReset,
	encodeWebSocketHead,
	encodeWelcome,
	type Hello,
	type HttpHead,
	isSendableCloseCode,
	MAX_CLOSE_REASON_BYTES,
	type MessageChunk,
	type Open,
	type Reset,
	type StreamKind,
	type WebSocketHead,
} from "./payloads.ts";
export { decodeUtf8, encodeUtf8 } from "./utf8.ts";

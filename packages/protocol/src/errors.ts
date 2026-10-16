/** Input that breaks the protocol: a malformed frame, payload or field, or a frame that breaks the rules of its stream. */
export class ProtocolError extends Error {
	override readonly name = "ProtocolError";
}

// The types of worker.js: the relay on Cloudflare Workers, its Worker and its Durable Object class of homes.

/** How a deployment defines its relay. */
export interface RelayOptions {
	/** The binding of the class of homes; `HOMES` where not given. */
	readonly binding?: string;
	/** Whether `request` may reach the home of `home`, a key's text; every request may where not given. */
	readonly authorize?: (request: Request, env: unknown, home: string) => Promise<boolean>;
}

/** A relay: the Worker that routes each request to the home its path names, and the class of homes. */
export interface Relay {
	readonly worker: ExportedHandler;
	readonly Home: new (ctx: DurableObjectState, env: unknown) => DurableObject;
}

/** Defines the relay: its Worker and its Durable Object class of homes, bound as `options.binding`. */
export declare function defineRelay(options?: RelayOptions): Relay;

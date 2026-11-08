// The types of worker.js: the relay on Cloudflare Workers, its Worker and its Durable Object class of homes.

/** How a deployment defines its relay, its Worker's bindings `Env`. */
export interface RelayOptions<Env> {
	/** The binding of the class of homes; `HOMES` where not given. */
	readonly binding?: string;
	/** Whether `request` may reach the home of `home`, a key's text; every request may where not given. */
	readonly authorize?: (request: Request, env: Env, home: string) => Promise<boolean>;
}

/** A home: the Durable Object of a machine's key, which holds the links of the machine and of the peers that reach it. */
export interface Home extends DurableObject {
	/** The keys of the peers on the home now, each admitted by its answer; the machine's own among them while it is on
	 * its home. */
	peers(): Promise<string[]>;
}

/** A relay: the Worker that routes each request to the home its path names, and the class of homes. */
export interface Relay<Env> {
	readonly worker: ExportedHandler<Env>;
	readonly Home: new (ctx: DurableObjectState, env: Env) => Home;
}

/** Defines the relay: its Worker and its Durable Object class of homes, bound as `options.binding`. */
export declare function defineRelay<Env = unknown>(options?: RelayOptions<Env>): Relay<Env>;

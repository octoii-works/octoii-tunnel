// The types of worker.js: the relay on Cloudflare Workers, its Worker and its Durable Object class of homes.

/** How a deployment defines its relay, its Worker's bindings `Env`. */
export interface RelayOptions<Env> {
	/** The binding of the class of homes; `HOMES` where not given. */
	readonly binding?: string;
	/** Whether `request` may reach the home of `home`, a key's text; every request may where not given. */
	readonly authorize?: (request: Request, env: Env, home: string) => Promise<boolean>;
	/** The machine's home and the route a visitor's `request` is for; null where it is for none, and goes to a home as a
	 * peer's. No request is for a route where not given. */
	readonly routeOf?: (request: Request, env: Env) => Promise<{ readonly home: string; readonly name: string } | null>;
}

/** A home: the Durable Object of a machine's key, which holds the links of the machine and of the peers that reach it. */
export interface Home extends DurableObject {
	/** The keys of the peers on the home now, each admitted by its answer; the machine's own among them while it is on
	 * its home. */
	peers(): Promise<string[]>;
	/** Carries a visitor's `request` to the machine's route `name`: the machine's answer, as it comes. */
	route(name: string, request: Request): Promise<Response>;
	/** The names of the routes the machine says it has, while it is on its home. */
	routes(): Promise<string[]>;
	/** Asks the machine to remove its route `name`: whether it was there to be asked. */
	removeRoute(name: string): Promise<boolean>;
}

/** A relay: the Worker that routes each request to the home its path names, and the class of homes. */
export interface Relay<Env> {
	readonly worker: ExportedHandler<Env>;
	readonly Home: new (ctx: DurableObjectState, env: Env) => Home;
}

/** Defines the relay: its Worker and its Durable Object class of homes, bound as `options.binding`. */
export declare function defineRelay<Env = unknown>(options?: RelayOptions<Env>): Relay<Env>;
